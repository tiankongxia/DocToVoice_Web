#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import cgi
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

from docx import Document
from pydub import AudioSegment
from pydub.utils import which


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
OUTPUT_DIR = BASE_DIR / "outputs"
TMP_DIR = BASE_DIR / "tmp"

OUTPUT_DIR.mkdir(exist_ok=True)
TMP_DIR.mkdir(exist_ok=True)

os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/Caskroom/miniforge/base/bin:" + os.environ.get("PATH", "")
os.environ["FFMPEG_BINARY"] = "/opt/homebrew/bin/ffmpeg"
os.environ["FFPROBE_BINARY"] = "/opt/homebrew/bin/ffprobe"

AudioSegment.converter = which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
AudioSegment.ffprobe = which("ffprobe") or "/opt/homebrew/bin/ffprobe"

EDGE_TTS = which("edge-tts") or "/opt/homebrew/Caskroom/miniforge/base/bin/edge-tts"

DEFAULT_VOICE = "zh-CN-YunjianNeural"
DEFAULT_RATE = "-5%"
DEFAULT_MAX_CHARS = 5000
DEFAULT_PAUSE_MS = 1000
TEMP_AUDIO_PREFIX = "temp_audio_"
PUNCTUATION_TO_NEWLINE = "。，？！；、——!?：:…【】"
REMOVE_CHARS = "\"'""'' "

VOICES = [
    "zh-CN-YunjianNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-XiaoyiNeural",
]

jobs: dict[str, "Job"] = {}


class Job:
    def __init__(self, title: str):
        self.id = uuid.uuid4().hex
        self.title = title
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.status = "queued"
        self.progress = 0
        self.message = "已加入队列"
        self.files: list[dict[str, str]] = []
        self.error: str | None = None
        self.events: queue.Queue[dict] = queue.Queue()

    def emit(self, **payload):
        if "status" in payload:
            self.status = payload["status"]
        if "progress" in payload:
            self.progress = payload["progress"]
        if "message" in payload:
            self.message = payload["message"]
        if "error" in payload:
            self.error = payload["error"]
        if "files" in payload:
            self.files = payload["files"]
        event = {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "files": self.files,
            "error": self.error,
        }
        event.update(payload)
        self.events.put(event)


def safe_name(value: str, fallback: str = "朗读") -> str:
    value = value.strip() or fallback
    value = re.sub(r"[\\/:*?\"<>|\r\n]+", "_", value)
    return value[:60] or fallback


def read_docx(file_path: Path) -> list[str]:
    doc = Document(str(file_path))
    return [p.text.strip() for p in doc.paragraphs if p.text.strip()]


def suggested_title(paragraphs: list[str]) -> str:
    for para in paragraphs:
        text = re.sub(r"\[\[(.*?)\|(.*?)\]\]", r"\1", para)
        text = " ".join(text.replace("\u00a0", " ").split()).strip()
        if text:
            return text[:32]
    return "朗读"


def replace_titles_in_docx(filename: Path) -> Path:
    doc = Document(str(filename))
    pattern = r"《(.*?)》"
    replaced = False
    for para in doc.paragraphs:
        for run in para.runs:
            new = re.sub(pattern, r"[[《\1》|\1]]", run.text)
            if new != run.text:
                run.text = new
                replaced = True
    if not replaced:
        return filename
    new_name = filename.with_name(filename.stem + "_replaced.docx")
    doc.save(str(new_name))
    return new_name


def split_into_blocks(paragraphs: list[str], max_chars: int) -> list[list[str]]:
    blocks: list[list[str]] = []
    current: list[str] = []
    current_len = 0
    for para in paragraphs:
        if current and current_len + len(para) > max_chars:
            blocks.append(current)
            current = [para]
            current_len = len(para)
        else:
            current.append(para)
            current_len += len(para)
    if current:
        blocks.append(current)
    return blocks


def process_for_tts(text: str) -> str:
    return re.sub(r"\[\[(.*?)\|(.*?)\]\]", r"\2", text)


def process_for_subtitle(text: str) -> str:
    text = re.sub(r"\[\[(.*?)\|(.*?)\]\]", r"\1", text)
    title_map = {}

    def save_title(match):
        key = f"<TITLE_{len(title_map)}>"
        title_map[key] = match.group(0)
        return key

    text = re.sub(r"《.*?》", save_title, text)
    for punct in PUNCTUATION_TO_NEWLINE:
        text = text.replace(punct, "\n")
    text = re.sub(f"[{re.escape(REMOVE_CHARS)}]", "", text)
    for key, value in title_map.items():
        text = text.replace(key, value)
    return text.strip()


def save_subtitle(text: str, index: int, out_dir: Path) -> Path:
    path = out_dir / f"cc_{index + 1}.docx"
    doc = Document()
    for line in text.split("\n"):
        doc.add_paragraph(line)
    doc.save(str(path))
    return path


def normalize_dropbox_url(url: str) -> str:
    if "dl=0" in url:
        return url.replace("dl=0", "dl=1")
    if "dl=1" not in url:
        return url + ("&" if "?" in url else "?") + "dl=1"
    return url


def download_docx(url: str, target: Path):
    req = Request(normalize_dropbox_url(url), headers={"User-Agent": "LangduWeb/1.0"})
    with urlopen(req, timeout=60) as response:
        target.write_bytes(response.read())


def as_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def synthesize_block(
    block: list[str],
    target: Path,
    job: Job,
    voice: str,
    rate: str,
    pause_ms: int,
    total_paras: int,
    done_ref: list[int],
    block_label: str,
):
    combined = AudioSegment.empty()
    temp_files: list[Path] = []

    for index, para in enumerate(block):
        temp_mp3 = target.parent / f"{TEMP_AUDIO_PREFIX}{target.stem}_{index}.mp3"
        tts_text = process_for_tts(para)
        ok = False

        for attempt in range(3):
            job.emit(
                status="running",
                message=f"{block_label}：正在合成第 {index + 1}/{len(block)} 段",
            )
            cmd = [
                EDGE_TTS,
                "--text",
                tts_text,
                "--voice",
                voice,
                f"--rate={rate}",
                "--write-media",
                str(temp_mp3),
            ]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if temp_mp3.exists() and temp_mp3.stat().st_size > 0:
                ok = True
                break
            time.sleep(1 + attempt)

        done_ref[0] += 1
        progress = int(done_ref[0] / max(1, total_paras) * 95)
        job.emit(progress=progress)

        if not ok:
            job.emit(message=f"{block_label}：第 {index + 1} 段失败，已跳过")
            continue

        segment = AudioSegment.from_file(str(temp_mp3), format="mp3")
        combined += segment + AudioSegment.silent(duration=pause_ms)
        temp_files.append(temp_mp3)

    if len(combined) == 0:
        raise RuntimeError("没有成功生成任何音频")

    combined.export(str(target), format="mp3", bitrate="192k")

    for item in temp_files:
        item.unlink(missing_ok=True)


def run_job(job: Job, payload: dict):
    work_dir = TMP_DIR / job.id
    out_dir = OUTPUT_DIR / job.id
    work_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        mode = payload["mode"]
        voice = payload["voice"] if payload["voice"] in VOICES else DEFAULT_VOICE
        rate = payload["rate"] or DEFAULT_RATE
        max_chars = payload["max_chars"]
        pause_ms = payload["pause_ms"]

        job.emit(status="running", progress=2, message="正在读取内容")

        if mode in {"file", "url"}:
            docx_path = work_dir / "input.docx"
            if mode == "file":
                shutil.copyfile(payload["file_path"], docx_path)
                Path(payload["file_path"]).unlink(missing_ok=True)
            else:
                download_docx(payload["url"], docx_path)
            docx_path = replace_titles_in_docx(docx_path)
            paragraphs = read_docx(docx_path)
            if not paragraphs:
                raise RuntimeError("文档里没有可朗读的内容")
            blocks = split_into_blocks(paragraphs, max_chars)
            title = safe_name(payload.get("title") or suggested_title(paragraphs))
            job.title = title
        else:
            raw = payload["text"].strip()
            paragraphs = [line.strip() for line in raw.splitlines() if line.strip()] or [raw]
            blocks = [paragraphs]
            title = safe_name(payload.get("title") or f"update-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
            job.title = title

        total_paras = sum(len(block) for block in blocks)
        done_ref = [0]
        files: list[dict[str, str]] = []

        job.emit(progress=5, message=f"共 {len(blocks)} 个音频文件，{total_paras} 段")

        for block_index, block in enumerate(blocks):
            if mode == "text":
                filename = f"{title}.mp3"
            else:
                filename = f"output_{block_index + 1}.mp3"
            mp3_path = out_dir / filename
            label = f"音频 {block_index + 1}/{len(blocks)}"
            synthesize_block(block, mp3_path, job, voice, rate, pause_ms, total_paras, done_ref, label)
            files.append({"name": mp3_path.name, "url": f"/outputs/{job.id}/{mp3_path.name}", "type": "audio"})

            if mode in {"file", "url"}:
                subtitle_text = process_for_subtitle("\n".join(block))
                cc_path = save_subtitle(subtitle_text, block_index, out_dir)
                files.append({"name": cc_path.name, "url": f"/outputs/{job.id}/{cc_path.name}", "type": "docx"})

        job.emit(status="done", progress=100, message="完成", files=files)
    except Exception as exc:
        job.emit(status="error", error=str(exc), message="出错")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


class LangduHandler(BaseHTTPRequestHandler):
    server_version = "LangduWeb/1.0"

    def log_message(self, format, *args):
        print("[%s] %s" % (self.log_date_time_string(), format % args))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/":
            self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        elif path == "/health":
            self.json_response({"ok": True})
        elif path.startswith("/static/"):
            self.serve_static(path)
        elif path.startswith("/outputs/"):
            self.serve_output(path)
        elif path.startswith("/api/jobs/") and path.endswith("/events"):
            self.serve_events(path)
        elif path.startswith("/api/jobs/"):
            self.serve_job(path)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/":
            self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8", head_only=True)
        elif path.startswith("/static/"):
            self.serve_static(path, head_only=True)
        elif path.startswith("/outputs/"):
            self.serve_output(path, head_only=True)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        if self.path == "/api/jobs":
            self.create_job()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def end_headers(self):
        self.send_cors_headers()
        super().end_headers()

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", os.environ.get("CORS_ALLOW_ORIGIN", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def serve_static(self, path: str, head_only: bool = False):
        file_path = (STATIC_DIR / path.removeprefix("/static/")).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        content_type = "text/plain; charset=utf-8"
        if file_path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif file_path.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        self.serve_file(file_path, content_type, head_only=head_only)

    def serve_output(self, path: str, head_only: bool = False):
        file_path = (BASE_DIR / path.removeprefix("/")).resolve()
        if not str(file_path).startswith(str(OUTPUT_DIR.resolve())):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        content_type = "application/octet-stream"
        if file_path.suffix == ".mp3":
            content_type = "audio/mpeg"
        self.serve_file(file_path, content_type, head_only=head_only)

    def serve_file(self, file_path: Path, content_type: str, head_only: bool = False):
        if not file_path.exists() or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def serve_events(self, path: str):
        job_id = path.split("/")[3]
        job = jobs.get(job_id)
        if not job:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        job.emit()
        while True:
            try:
                event = job.events.get(timeout=20)
            except queue.Empty:
                event = {"status": job.status, "message": job.message, "progress": job.progress}
            data = "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
            try:
                self.wfile.write(data.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                break
            if event.get("status") in {"done", "error"}:
                break

    def serve_job(self, path: str):
        job_id = path.split("/")[3]
        job = jobs.get(job_id)
        if not job:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.json_response(
            {
                "id": job.id,
                "title": job.title,
                "status": job.status,
                "progress": job.progress,
                "message": job.message,
                "files": job.files,
                "error": job.error,
            }
        )

    def create_job(self):
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})

        mode = form.getfirst("mode", "text")
        title = safe_name(form.getfirst("title", "") or "朗读")
        voice = form.getfirst("voice", DEFAULT_VOICE)
        rate = form.getfirst("rate", DEFAULT_RATE)
        max_chars = as_int(form.getfirst("max_chars"), DEFAULT_MAX_CHARS, 500, 20000)
        pause_ms = as_int(form.getfirst("pause_ms"), DEFAULT_PAUSE_MS, 0, 5000)

        payload = {
            "mode": mode,
            "title": title,
            "voice": voice,
            "rate": rate,
            "max_chars": max_chars,
            "pause_ms": pause_ms,
        }

        try:
            if mode == "file":
                item = form["file"]
                if not getattr(item, "filename", None):
                    raise ValueError("请选择 .docx 文件")
                upload_path = TMP_DIR / f"{uuid.uuid4().hex}.docx"
                with upload_path.open("wb") as handle:
                    shutil.copyfileobj(item.file, handle)
                payload["file_path"] = upload_path
            elif mode == "url":
                url = form.getfirst("url", "").strip()
                if not url:
                    raise ValueError("请填写 Dropbox 文档链接")
                payload["url"] = url
            else:
                text = form.getfirst("text", "").strip()
                if not text:
                    raise ValueError("请输入要朗读的文字")
                payload["mode"] = "text"
                payload["text"] = text
        except Exception as exc:
            self.json_response({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return

        job = Job(title=title)
        jobs[job.id] = job
        thread = threading.Thread(target=run_job, args=(job, payload), daemon=True)
        thread.start()
        self.json_response({"id": job.id})

    def json_response(self, payload: dict, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    host = os.environ.get("LANGDU_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT") or os.environ.get("LANGDU_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), LangduHandler)
    print(f"朗读网页版已启动：http://localhost:{port}")
    print("同一 Wi-Fi 下，手机可访问这台电脑的局域网 IP 加端口。")
    server.serve_forever()


if __name__ == "__main__":
    main()
