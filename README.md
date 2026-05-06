# DocToVoice Web

把 Dropbox 文档链接转成中文朗读 MP3，并可生成字幕 `.docx`。

## 架构

- `frontend/`: 静态网页，部署到 Netlify。
- `backend/`: Python 服务，部署到 Render/Railway/Fly.io 等支持 Docker 的平台。

Netlify 只负责网页和代理请求；音频生成由后端完成，因为它需要 `edge-tts`、`ffmpeg`、`python-docx` 和 `pydub`。

## 交互

- 首页只保留 Dropbox 链接、粘贴按钮、开始生成和结果。
- 声音、语速、段落停顿、分块模式放在 `frontend/settings.html`。
- 分块默认是不分块；开启自动分块后按约 5000 字一块输出。

## 1. 部署后端到 Render

1. 打开 Render，选择 New > Web Service。
2. 连接这个 GitHub 仓库。
3. 如果 Railway 能看到 Root Directory，填：

```text
backend
```

如果看不到也没关系，仓库根目录已经有 `Dockerfile` 和 `railway.json`，直接部署即可。

4. Environment 选择 Docker，或保持 Railway 自动识别。
5. 部署完成后，记下后端地址，例如：

```text
https://doctovoiceweb-production.up.railway.app
```

## 2. 配置 Netlify 前端

推荐使用 Netlify 代理。先编辑：

```text
frontend/netlify.toml
```

把里面两个：

```text
https://doctovoiceweb-production.up.railway.app
```

替换成你的 Render 后端地址。

然后在 Netlify：

1. Add new project > Import an existing project。
2. 选择 GitHub 和这个仓库。
3. Base directory 填：

```text
frontend
```

4. Build command 留空。
5. Publish directory 填：

```text
.
```

6. Deploy。

前端也可以直接调用后端。编辑：

```text
frontend/config.js
```

当前已经配置为 Railway 后端地址：

```js
window.API_BASE_URL = "https://doctovoiceweb-production.up.railway.app";
```

## 本地运行

后端：

```bash
cd backend
python server.py
```

前端可以直接打开 `frontend/index.html`，或用任意静态服务器打开。
