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
BLOB_STORE_NAME=license-store
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

## EdgeOne Pages 部署

当前分支是 EdgeOne Pages 全栈部署分支。普通服务器部署继续使用 `main` 分支。

EdgeOne Pages 项目建议通过 Git 仓库部署，构建配置由 `edgeone.json` 提供：

- 安装命令：`npm install`
- 构建命令：`npm run build`
- 输出目录：`dist`
- Cloud Functions 地域：`ap-guangzhou`
- Cloud Functions Node.js 最大执行时间：`120s`

在 EdgeOne Pages 控制台配置环境变量：

```text
ADMIN_PASSWORD=your-admin-password
SESSION_SECRET=replace-with-a-long-random-secret
BLOB_STORE_NAME=license-store
API_BASE_URL=https://api.example.com/v1
API_KEY=your-api-key
API_MODEL=gpt-image-1
IMAGE_PROXY_BODY_LIMIT_MB=6
```

第一版 EdgeOne 不接 MySQL 和 COS。生成图片只保存在用户当前浏览器 IndexedDB，历史元数据保存在当前浏览器 localStorage；EdgeOne Pages Blob 只保存卡密、登录 session 和扣次记录。

部署步骤：

1. 推送分支和 tag：
   ```bash
   git switch codex/edgeone-pages
   git push -u origin codex/edgeone-pages
   git push origin v0.4.0-edgeone.3
   ```
2. 在 EdgeOne Pages 新建项目，选择“导入 Git 仓库”，分支选择 `codex/edgeone-pages`。
3. 构建配置使用 `edgeone.json`；如需手动填写，则安装命令为 `npm install`，构建命令为 `npm run build`，输出目录为 `dist`，Node.js 版本为 `20.18.0`。
4. 在环境变量中配置上方变量，不要再配置 `DATABASE_URL`、`MYSQL_CONNECTION_LIMIT`、`MYSQL_TEST_DATABASE_URL`、`CARD_DB_PATH`。
5. 部署完成后访问 `/admin.html`，用 `ADMIN_PASSWORD` 登录并生成卡密，再回到用户页用卡密生成图片。
6. 到 EdgeOne 控制台 Blob Storage 查看 `license-store` 命名空间，确认有 `cards/`、`sessions/`、`usage/` 对象。

## 版本管理

当前 EdgeOne 分支版本为 `v0.4.0-edgeone.3`。

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

EdgeOne Cloud Functions 请求体上限为 6MB，后端图片代理默认按 `IMAGE_PROXY_BODY_LIMIT_MB=6` 处理。前端会在生成前校验请求体大小，超出时要求压缩或更换参考图。

## 本地数据

- API 配置：`localStorage`
- 历史元数据：`localStorage`
- 图片和缩略图：`IndexedDB`
- 历史最多保留 20 条，超出后自动删除最旧图片数据
- 卡密数据：EdgeOne Pages Blob，本地开发默认写入 `data/blob-license`
- 卡密登录：后端 HttpOnly Cookie session
