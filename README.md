# 电商 AI 生图工作台

一个电商图片生成网站应用。默认可通过后端环境变量配置 OpenAI-compatible 聚合 API；用户也可以在前端“API 设置”里填写自己的 `baseURL`、`apiKey` 和 `model` 覆盖服务器默认配置。

## 功能

- 商品主图、白底图、生活场景图、详情页配图、节日促销图模板
- 支持文生图和商品参考图两种模式
- 商品参考图模式会把上传的真实商品图作为 `image_urls` 发给支持图生图的模型
- 淘宝/天猫、京东、拼多多、抖音电商、小红书等平台标签和常用比例预设
- 自动拼装适合电商图片生产的英文提示词
- 兼容 `/images/generations` 风格接口，优先请求 `b64_json`
- 支持接口返回 `b64_json` 或临时 `url`
- IndexedDB 保存图片 Blob，localStorage 保存最多 20 条历史元数据
- 支持打开历史、重新生成、复制提示词、原图下载、按规格导出 PNG/JPG
- 使用 Canvas 在浏览器本地进行尺寸适配和导出
- 支持 6 位卡密登录、剩余次数展示、成功生成/续改后扣减次数
- 独立卡密管理后台支持批量生成 10/20/30/50/100 次卡密、启用/禁用、CSV/JSON 导出

## 启动

```bash
npm install
```

复制 `.env.example` 为 `.env`，并把里面的占位值改成真实配置：

```bash
copy .env.example .env
```

`.env` 中至少需要配置：

```text
ADMIN_PASSWORD=your-admin-password
SESSION_SECRET=replace-with-a-long-random-secret
CARD_DB_PATH=data/cards.sqlite
API_BASE_URL=https://api.example.com/v1
API_KEY=your-api-key
API_MODEL=gpt-image-1
```

`.env` 已被 `.gitignore` 忽略，不要提交真实密钥。

本地开发时需要两个终端。

终端 1：启动后端服务：

```bash
npm run server
```

终端 2：启动 Vite 前端开发服务：

```bash
npm run dev
```

访问 Vite 输出的本地地址，通常是：

```text
http://127.0.0.1:5173
```

Vite 开发服务器会把 `/api` 代理到 `http://127.0.0.1:8787`。

## 构建

```bash
npm run build
```

构建产物会输出到 `dist/`。

生产运行示例：

```bash
npm run build
npm run server
```

`npm run server` 会自动读取当前目录下的 `.env`。正式线上环境也可以改用部署平台提供的环境变量或密钥管理服务。

用户页面：

```text
http://127.0.0.1:8787/
```

站长卡密管理页：

```text
http://127.0.0.1:8787/admin.html
```

## 版本管理

当前版本为 `v0.3.2`。

后续每次功能修改或修复，按下面的节奏管理版本：

1. 修改代码
2. 运行 `npm run build` 验证
3. 提交 Git commit
4. 更新 `package.json` 里的 `version`
5. 追加一条 `CHANGELOG.md`
6. 打对应标签，例如 `v0.1.1`

常见版本规则：

- `0.1.1`：修复问题、小改动
- `0.2.0`：新增功能，但不重做整体架构
- `1.0.0`：稳定可发布的大版本

查看历史版本：

```bash
git tag
git log --oneline --decorate
```

## API 兼容说明

第一版按 OpenAI Images API 风格实现：

```text
POST {baseURL}/images/generations
Authorization: Bearer {apiKey}
Content-Type: application/json
```

请求体包含：

- `model`
- `prompt`
- `size`
- `n: 1`
- `quality`
- `response_format: "b64_json"`

APIMart `gpt-image-2` 会使用异步任务模式，站点会自动轮询 `/tasks/{task_id}`。商品参考图模式会额外传入 `image_urls`，当前实现使用浏览器压缩后的 base64 data URI。

使用后端环境默认配置时，图片生成会经由后端代理调用第三方 API，服务器 `API_KEY` 不会返回给浏览器。用户在前端“API 设置”中保存了自己的配置后，会优先使用前端配置并继续由浏览器直连第三方 API；这种模式仍要求第三方服务允许浏览器跨域请求。

API 参数优先级：

1. 当前浏览器在“API 设置”中保存的配置
2. 后端环境变量默认配置：`API_BASE_URL`、`API_KEY`、`API_MODEL`

兼容环境变量别名：`OPENAI_BASE_URL` / `IMAGE_API_BASE_URL`、`OPENAI_API_KEY` / `IMAGE_API_KEY`、`OPENAI_MODEL` / `IMAGE_API_MODEL`。

后端图片代理请求体默认最大 25MB，可用 `IMAGE_PROXY_BODY_LIMIT_MB` 调整。

## 本地数据

- API 配置：`localStorage`
- 历史元数据：`localStorage`
- 图片和缩略图：`IndexedDB`
- 历史最多保留 20 条，超出后自动删除最旧图片数据
- 卡密数据：后端 SQLite，默认 `data/cards.sqlite`
- 卡密登录：后端 HttpOnly Cookie session
