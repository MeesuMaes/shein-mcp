# 给智能体的安装说明

用户要求安装 shein-mcp 时，按本文执行。不要改仓库源码，不要把 App Secret、Secret Key、tempToken 写进聊天记录、命令回显或 git。

仓库：https://github.com/MeesuMaes/shein-mcp

安装目录固定为 `$HOME/.shein-mcp/app`。授权结果写在 `$HOME/.shein-mcp/credentials.json`，两者不要混在同一个目录里。

## 你可以自己做完的部分

1. 确认 `node -v` 不低于 22.12。版本不够就停下来告诉用户，不要换一个更旧的 Node 继续装。
2. 克隆到固定目录。目录已经是这个仓库时改为拉取更新。

```bash
if [ -d "$HOME/.shein-mcp/app/.git" ]; then
  git -C "$HOME/.shein-mcp/app" pull --ff-only
else
  git clone https://github.com/MeesuMaes/shein-mcp.git "$HOME/.shein-mcp/app"
fi
cd "$HOME/.shein-mcp/app"
npm install
npm run build
```

3. 不带凭据、不访问 SHEIN，验收构建结果。输出里必须有 `"count": 129`。没有就停，把命令的原始错误交给用户。

```bash
node "$HOME/.shein-mcp/app/dist/index.js" list-actions
```

4. 用**绝对路径**登记到当前宿主。stdio 启动不会经过 shell，不要写成一条 `shein-mcp serve` 字符串。

```json
{
  "command": "<which node 的绝对路径>",
  "args": ["<HOME>/.shein-mcp/app/dist/index.js", "serve"]
}
```

把 `<which node 的绝对路径>` 和 `<HOME>` 换成你刚查到的真实值。不要在 `env` 里放密钥；服务启动后自己读 `~/.shein-mcp/credentials.json`。

### Orkas

调用 `add_custom_connector`，然后停下来等用户在确认框里点同意。用户拒绝后不要重试。

```json
{
  "name": "SHEIN",
  "transport": {
    "kind": "stdio",
    "command": "<node 绝对路径>",
    "args": ["<HOME>/.shein-mcp/app/dist/index.js", "serve"]
  }
}
```

`name` 只能含字母、数字、空格、`.`、`_`、`/`、`-`，最长 64。不要向用户索要密钥贴进对话；还缺保护字段时，改让用户到「连接器 → 添加 MCP 服务器」里填写。

### Claude Code

在用户级或项目级 MCP 配置里加入下面这项，路径同样用绝对路径：

```json
{
  "mcpServers": {
    "shein": {
      "command": "<node 绝对路径>",
      "args": ["<HOME>/.shein-mcp/app/dist/index.js", "serve"]
    }
  }
}
```

### Cursor 以及其他宿主

写入该宿主的 `mcp.json`，`command` 与 `args` 与上面相同。

## 你不能替用户做完的部分

没有已审批的 SHEIN 自运营或半托管应用时，安装停在「已登记、未授权」。不要编造 App ID、App Secret 或 tempToken。

用户已经持有 App ID 和 App Secret 时：

```bash
node "$HOME/.shein-mcp/app/dist/index.js" authorize --app-id "$SHEIN_APP_ID" --app-secret "$SHEIN_APP_SECRET"
```

把命令打印出的回调地址和授权 URL 交给用户。用户在 SHEIN 开放平台登记这个回调，并用店铺主账号授权。回调里的 tempToken 由用户自己执行下一步，或者在不回显密钥的本地终端里交给你：

```bash
node "$HOME/.shein-mcp/app/dist/index.js" authorize --temp-token "$SHEIN_TEMP_TOKEN"
```

成功后凭据写入 `~/.shein-mcp/credentials.json`（权限 `0600`）。再用下面的命令确认店铺身份；失败就把原始错误交给用户，不要改签名或重试写入。

```bash
node "$HOME/.shein-mcp/app/dist/index.js" whoami
```

## 装好之后怎么调用

先 `list_capabilities`，再用 `describe_action` 看单个动作的参数。然后按该动作的风险调用对应工具：

| 风险 | 工具 |
| --- | --- |
| R | `execute_read` |
| W | `execute_write` |
| H | `execute_high_impact` |
| D | `execute_destructive` |

风险和工具不一致会被拒绝。写入只表示平台已受理（`acknowledged`）或有部分失败（`partial_or_failed`），不表示审核或发货已经完成。失败时先查看返回里点名的资源，不要自动重放同一次写入。
