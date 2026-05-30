from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse


HOST = os.environ.get("MINIAPP_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("MINIAPP_SERVER_PORT", "17892"))
TOKEN = os.environ.get("MINIAPP_SERVER_TOKEN", "")
DEFAULT_USER_ID = os.environ.get("MINIAPP_SERVER_DEFAULT_USER_ID", "default")

REPO_ROOT = Path(__file__).resolve().parents[1]
MINIAPP_ROOT = REPO_ROOT / "miniapp" / "src"
VENDOR_ROOT = REPO_ROOT / "miniapp" / "node_modules"

CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
}

STATIC_FILES = {
    "/vendor/marked.esm.js": VENDOR_ROOT / "marked" / "lib" / "marked.esm.js",
    "/vendor/purify.es.mjs": VENDOR_ROOT / "dompurify" / "dist" / "purify.es.mjs",
}

API_PREFIXES = (
    "/health",
    "/capabilities",
    "/permissions",
    "/elicitations",
    "/projects",
    "/sessions",
    "/events",
)


@dataclass
class PendingStream:
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)


@dataclass
class Connector:
    user_id: str
    websocket: WebSocket
    agent_info: dict[str, Any] = field(default_factory=dict)
    pending_responses: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    pending_streams: dict[str, PendingStream] = field(default_factory=dict)


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["authorization", "content-type", "x-remote-acp-user-id"],
)

connectors: dict[str, Connector] = {}


@app.websocket("/connector")
async def connector_socket(websocket: WebSocket) -> None:
    if not is_authorized(str(websocket.url), websocket.headers.get("authorization")):
        await websocket.close(code=1008, reason="unauthorized")
        return

    await websocket.accept()
    user_id = user_id_from_url(str(websocket.url))
    existing = connectors.get(user_id)
    if existing:
        await close_connector(existing, code=1012, reason="replaced")

    connector = Connector(user_id=user_id, websocket=websocket)
    connectors[user_id] = connector

    try:
        while True:
            raw = await websocket.receive_text()
            await handle_connector_message(connector, raw)
    except WebSocketDisconnect:
        pass
    finally:
        if connectors.get(user_id) is connector:
            connectors.pop(user_id, None)
        fail_all_pending(connector, "connector_disconnected")


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
async def handle_request(path: str, request: Request) -> Response:
    pathname = "/" + path
    if pathname == "/":
        pathname = "/index.html"

    if is_api_path(pathname):
        return await forward_api_request(request, pathname)

    return await serve_static(pathname)


async def serve_static(pathname: str) -> Response:
    try:
        vendor_path = STATIC_FILES.get(pathname)
        if vendor_path:
            file_path = vendor_path.resolve()
        else:
            relative = unquote(pathname.lstrip("/")) or "index.html"
            file_path = (MINIAPP_ROOT / relative).resolve()
            file_path.relative_to(MINIAPP_ROOT.resolve())

        body = file_path.read_bytes()
        return Response(
            body,
            media_type=CONTENT_TYPES.get(file_path.suffix, "application/octet-stream"),
        )
    except ValueError:
        return Response("forbidden", status_code=403)
    except OSError:
        return Response("not found", status_code=404)


async def forward_api_request(request: Request, pathname: str) -> Response:
    user_id = user_id_from_request(request)
    connector = connectors.get(user_id)
    if not connector:
        return JSONResponse(
            {
                "error": "connector_unavailable",
                "message": f"No connector is connected for user: {user_id}.",
            },
            status_code=503,
        )

    request_id = str(uuid.uuid4())
    path_with_query = pathname
    if request.url.query:
        path_with_query += f"?{request.url.query}"

    headers = pick_headers(request)

    if pathname == "/events":
        return await open_forwarded_stream(connector, request_id, path_with_query, headers)

    body = (await request.body()).decode("utf-8")
    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    connector.pending_responses[request_id] = future

    await send_to_connector(
        connector,
        {
            "type": "http.request",
            "requestId": request_id,
            "method": request.method,
            "path": path_with_query,
            "headers": headers,
            "body": body,
        },
    )

    try:
        message = await asyncio.wait_for(future, timeout=120)
    except asyncio.TimeoutError:
        connector.pending_responses.pop(request_id, None)
        return JSONResponse(
            {
                "error": "connector_timeout",
                "message": "Connector did not respond before the request timeout.",
            },
            status_code=504,
        )

    return Response(
        content=message.get("body", ""),
        status_code=int(message.get("status") or 502),
        headers=normalize_headers(message.get("headers")),
    )


async def open_forwarded_stream(
    connector: Connector,
    stream_id: str,
    path: str,
    headers: dict[str, str],
) -> StreamingResponse:
    stream = PendingStream()
    connector.pending_streams[stream_id] = stream

    async def generate():
        try:
            await send_to_connector(
                connector,
                {
                    "type": "http.request",
                    "requestId": stream_id,
                    "method": "GET",
                    "path": path,
                    "headers": headers,
                },
            )
            while True:
                message = await stream.queue.get()
                if message is None:
                    break
                message_type = message.get("type")
                if message_type == "stream.chunk":
                    yield str(message.get("chunk") or "").encode("utf-8")
                elif message_type == "stream.error":
                    payload = json.dumps({"error": message.get("error")}, ensure_ascii=False)
                    yield f"event: error\ndata: {payload}\n\n".encode("utf-8")
                    break
                elif message_type == "stream.end":
                    break
        finally:
            connector.pending_streams.pop(stream_id, None)
            await send_to_connector(connector, {"type": "stream.close", "streamId": stream_id})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


async def handle_connector_message(connector: Connector, raw: str) -> None:
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        return

    message_type = message.get("type")
    if message_type == "connector.ready":
        connector.agent_info = message.get("agentInfo") or {}
        return

    if message_type == "http.response":
        request_id = message.get("requestId")
        future = connector.pending_responses.pop(request_id, None)
        if future and not future.done():
            future.set_result(message)
        return

    if message_type == "stream.start":
        return

    if message_type in {"stream.chunk", "stream.end", "stream.error"}:
        stream_id = message.get("streamId")
        stream = connector.pending_streams.get(stream_id)
        if stream:
            await stream.queue.put(message)
            if message_type in {"stream.end", "stream.error"}:
                await stream.queue.put(None)
        return

    if message_type == "connector.info":
        connector.agent_info = message.get("agentInfo") or connector.agent_info


def fail_all_pending(connector: Connector, reason: str) -> None:
    for future in connector.pending_responses.values():
        if not future.done():
            future.set_result(
                {
                    "status": 503,
                    "headers": {"Content-Type": "application/json; charset=utf-8"},
                    "body": json.dumps({"error": reason}),
                },
            )
    connector.pending_responses.clear()

    for stream in connector.pending_streams.values():
        stream.queue.put_nowait(None)
    connector.pending_streams.clear()


async def close_connector(connector: Connector, code: int, reason: str) -> None:
    try:
        await connector.websocket.close(code=code, reason=reason)
    except RuntimeError:
        pass
    fail_all_pending(connector, reason)


async def send_to_connector(connector: Connector, message: dict[str, Any]) -> None:
    await connector.websocket.send_text(json.dumps(message, ensure_ascii=False))


def user_id_from_request(request: Request) -> str:
    header = request.headers.get("x-remote-acp-user-id")
    if header and header.strip():
        return header.strip()
    return user_id_from_url(str(request.url))


def user_id_from_url(raw_url: str) -> str:
    query = parse_qs(urlparse(raw_url).query)
    values = query.get("userId")
    if values and values[0].strip():
        return values[0].strip()
    return DEFAULT_USER_ID


def is_api_path(pathname: str) -> bool:
    return any(pathname == prefix or pathname.startswith(f"{prefix}/") for prefix in API_PREFIXES)


def is_authorized(raw_url: str, authorization: str | None) -> bool:
    if not TOKEN:
        return True
    query = parse_qs(urlparse(raw_url).query)
    query_token = query.get("token", [""])[0]
    return authorization == f"Bearer {TOKEN}" or query_token == TOKEN


def pick_headers(request: Request) -> dict[str, str]:
    picked = {}
    for key in ("accept", "content-type", "last-event-id"):
        value = request.headers.get(key)
        if value:
            picked[key] = value
    return picked


def normalize_headers(headers: Any) -> dict[str, str]:
    if not isinstance(headers, dict):
        return {"Content-Type": "application/json; charset=utf-8"}
    return {str(key): value for key, value in headers.items() if isinstance(value, str)}


def main() -> None:
    import uvicorn

    uvicorn.run("miniapp_server_py.server:app", host=HOST, port=PORT)


if __name__ == "__main__":
    main()
