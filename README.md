# 电商 AI 生图工作台

一个纯前端的电商图片生成网站应用。用户填写 OpenAI-compatible 聚合 API 的 `baseURL`、`apiKey` 和 `model` 后即可使用；配置、历史记录和图片都只保存在当前浏览器本地。

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

## 启动

```bash
npm install
npm run dev
```

访问 Vite 输出的本地地址，通常是：

```text
http://127.0.0.1:5173
```

## 构建

```bash
npm run build
```

构建产物会输出到 `dist/`。

## 版本管理

当前版本为 `v0.2.0`。

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

如果第三方中转站不允许浏览器跨域请求，前端会提示 CORS/连接失败。当前版本不引入后端代理，所以 API 服务需要支持浏览器直连。

## 本地数据

- API 配置：`localStorage`
- 历史元数据：`localStorage`
- 图片和缩略图：`IndexedDB`
- 历史最多保留 20 条，超出后自动删除最旧图片数据
