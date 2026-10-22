# glass-agent

[![中文](https://img.shields.io/badge/语言-中文-lightgrey)](README.md) [![English](https://img.shields.io/badge/Language-English-blue)](README.en.md)

A lightweight, read-only agent built with TypeScript and Node.js 24+. The model loop, context compaction, session recovery, workspace file and date tools, and ChatGPT and Qoder adapters live in `src/`. At runtime, `jose` validates ChatGPT OIDC ID tokens; TypeScript is used only for type checking.

## Install and run

```sh
cd glass-agent
npm ci
npm start -- --provider chatgpt --login
npm start -- --provider chatgpt --list-models
npm start -- --provider chatgpt --model 'model slug from the previous command' --workspace .
```

The default provider is `chatgpt`. Log in first, then choose a slug returned by your account's model catalog. Add a question at the end for a single response. Without a question, the CLI enters interactive mode; type `exit` to quit.

`--workspace` selects the directory the agent can inspect. By default, it uses the directory from which you start the command. The application gives the model only the workspace name; the model must call `list_files` and `read_file` to inspect filenames and source code. For questions about the current date or weekday, it can call `current_date`, which reads the current date in the `Asia/Shanghai` time zone. The agent's name is `smart-stella`. Terminal and Slack replies replace the workspace's absolute path with a path starting at its directory name, show other paths under the user's home directory with `~`, and replace other common local absolute paths with `[local path]`. Streaming output applies these path rules before displaying text.

## ChatGPT plan authorization

`--login` listens on `127.0.0.1:1455/auth/callback` on the computer running glass-agent (or another local port if that one is in use), prints the official authorization URL, and waits for five minutes. If the browser is on the same computer, the callback can be received automatically. If the browser is on another computer, complete authorization there and paste the **full callback URL from the browser's address bar into the glass-agent terminal**. The pasted input is not echoed. The browser may show that it cannot connect to the local callback address; you can still copy the URL from its address bar. A login attempt accepts its callback only once. Run `--login` again if it expires. Do not post the callback URL in a chat or ticket or write it to a log.

The first authorization registers with `dynamic_agent_client`; later logins use the permanent client ID returned in the callback. The application validates state, PKCE, the ID token signature and nonce, account identity, and authorization scopes before saving credentials. The host ID and credentials are stored by default in `~/.config/glass-agent/chatgpt/`, outside workspace sessions, with directory permissions `0700` and file permissions `0600`. Refresh uses a single local credential record and a cross-process lock, then atomically writes the rotated refresh token. ChatGPT credentials are sent only to the official authorization endpoint and `https://api.openai.com/v1/models` and `/responses`. `--base-url` is disabled for this provider. Plan eligibility, available models, and usage limits depend on the account's actual OpenAI authorization.

OpenAI documentation: [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [current limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Slack bot (Socket Mode)

glass-agent can connect to Slack from your computer, accept DMs from allowed users and explicit @mentions in channels, and answer with the existing ChatGPT model and read-only workspace tools. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) needs no public domain, ngrok tunnel, Request URL, or Signing Secret. The Kepler HTTP gateway configuration in the reference package does not apply to this local connection.

1. Create an app in [Slack App management](https://api.slack.com/apps). You can import the [manifest](examples/slack-app-manifest.yaml). Enable Socket Mode. The bot needs at least the `app_mentions:read`, `im:history`, and `chat:write` scopes, plus the `app_mention` and `message.im` bot events. Install or reinstall the app in your Slack workspace after changing scopes or events. Invite the bot to any channel where you want to use it.
2. Under **Basic Information → App-Level Tokens**, create an `xapp-...` token with the `connections:write` scope. Under **OAuth & Permissions → Bot User OAuth Token**, copy the `xoxb-...` token. Find your Slack **member ID** (`U...` or `W...`), which is different from the App ID, Bot ID, and workspace ID.
3. Create and edit a local configuration file:

   ```sh
   cd glass-agent
   npm start -- --slack-init
   nano ~/.config/glass-agent/slack.env
   ```

   Replace the placeholders for `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and `SLACK_ALLOWED_USERS`. Separate multiple user IDs with commas. Optionally set `SLACK_ALLOWED_CHANNELS` to `C...` or `G...` channel IDs to restrict channel mentions. Leave it empty to allow mentions by approved users in any channel the bot has joined. The file defaults to permissions `0600`, is outside the agent-readable workspace, and must not be committed to Git or shared in chat.
4. Start the bot with an authorized ChatGPT model:

   ```sh
   npm start -- --provider chatgpt --model 'model slug' --workspace . --slack
   ```

The bot calls `auth.test` to identify its Slack user ID. Slack sessions are saved by default under `.glass-agent/sessions/slack/` in the workspace. A file is created after the first successful answer and atomically updated after each later successful answer; its permissions are `0600`. A DM uses the Slack workspace ID and DM channel ID as one continuous conversation. A channel conversation uses the workspace ID, channel ID, and root message timestamp, so each thread has separate context. After stopping the bot, restart it with the **same `--workspace` and `--model`**, then send another message in the original DM or thread to resume automatically; `--continue` is not needed. Send `!new` in a DM to archive its previous session under `slack/archive/` and start fresh. In a channel, start a new root message and @mention the bot for a separate conversation. Conversations that existed only in memory before this feature was added cannot be recovered. This integration processes text only and does not download Slack attachments. The agent can still call only `list_files`, `read_file`, and `current_date`; the Slack adapter posts replies. Run only one Slack bot instance per workspace.

## API Key provider

The separate OpenAI Chat Completions API Key mode is still available:

```sh
export OPENAI_API_KEY='your model API key'
npm start -- --provider openai --model gpt-4.1-mini --workspace .
```

Set `--base-url` or `GLASS_BASE_URL` to change the endpoint. Remote URLs must use HTTPS; a local URL may use HTTP. ChatGPT plan mode never silently switches to API Key billing.

Interactive mode displays model text as it arrives. A single-question command waits for the complete answer by default. Use `--stream` to enable streaming for a single question, or `--no-stream` to disable it in interactive mode. ChatGPT plan mode always requests a streaming Responses result from the server. The parser collects text and completed output items, and accepts an answer or runs a tool only after receiving `response.completed`. If a stream fails after displaying some text, it reports the error and does not automatically retry the visible partial answer.

## Qoder

A Qoder Personal Access Token (PAT) is not an OpenAI API Key. The adapter exchanges the PAT for a short-lived job token, reads the models enabled for the account, and calls models through Qoder's native COSY protocol. glass-agent still controls tool calls and conversation history.

```sh
export QODER_PERSONAL_ACCESS_TOKEN='your Qoder PAT'
npm start -- --provider qoder --list-models
npm start -- --provider qoder --model 'model key from the previous command' --workspace .
```

You can also select a model by its full display name from the list. The default endpoint is `https://api2.qoder.sh`. `--base-url` and `QODER_BASE_URL` can select only the official `api2` and `api3` endpoints. The PAT and short-lived credentials remain only in process memory. The Qoder protocol adapter was informed by the local Kepler Agent implementation and may need updates if the server protocol changes.

## Sessions and context

Interactive CLI sessions and single questions are kept in memory by default; the agent does not write a local session file. Pass `--save` to persist one. Session files are written with permissions `0600` to `.glass-agent/sessions/<id>.json` in the workspace. `--continue` resumes the most recent session in that workspace; `--session PATH` chooses a session file. Both continue saving it. The workspace, provider, and model must match when restoring. Slack bot sessions are saved and restored automatically, with recognized common credential patterns redacted when written. The session format remains compatible with JSON files from the earlier Python version and includes the original conversation and tool results.

```sh
npm start -- --provider qoder --model 'model key' --workspace . --save
npm start -- --provider qoder --model 'model key' --workspace . --continue
```

The default context budget is 120,000 characters. Each `read_file` call returns at most 6,000 characters and provides an `offset` for further reading; a batch of tool calls shares an output budget of about 24,000 characters. When model context approaches its budget, older tool results are trimmed first while the two most recent are retained. If that is insufficient, completed question-and-answer turns or tool interactions are summarized in bounded chunks. The running session keeps the original tool results, which are also written if the session is persisted. The budget uses a character estimate, not the model's exact token limit. Summarization makes additional model requests.

## Failure retries

By default, model requests are retried up to two additional times after network timeouts or connection failures, HTTP 408/409/429/5xx responses, interrupted Qoder or ChatGPT streams, or empty answers. A server `Retry-After-Ms` or `Retry-After` value takes precedence. Otherwise, retries use exponential backoff of about 0.5 and 1 second with a little random jitter. If the server asks for a delay longer than 60 seconds, the request fails immediately. The terminal shows the retry count, wait time, and error. Use `--max-retries 0` to disable retries or another nonnegative integer to change the limit. Clear failures such as HTTP 401/403, an invalid model, or invalid protocol data fail immediately. Answers and summaries both use this policy; tools run only after a successful model request.

## Read-only permissions

The agent registers and can call only the built-in `list_files`, `read_file`, and `current_date` tools. Write tools, Bash, and command execution tools are rejected; a tool invented by the model is never run. File tools can access only visible UTF-8 files inside the workspace. Hidden files, `.git`, paths outside the workspace, and symlinks that escape it are inaccessible. Individual files are limited to 1 MiB. `read_file` uses a zero-based character `offset` for continued reading and redacts common credential patterns before content reaches the model. Terminal and Slack output also redact these patterns. The date tool reads only the system clock. The application itself writes session files when a session option or Slack bot mode calls for it. These limits apply to agent tools; they are not an operating system sandbox.

## Development

```sh
npm run check
npm test
```

| File | Purpose |
| --- | --- |
| `src/agent.ts` | Model and tool loop, context compaction, read-only tool validation |
| `src/retry.ts` | Bounded retries and backoff |
| `src/tools.ts` | Read-only workspace file tools and current date tool |
| `src/models.ts` | Chat Completions adapter |
| `src/output.ts` | Local path handling for terminal streaming and Slack replies |
| `src/secrets.ts` | Common credential pattern redaction |
| `src/chatgpt-auth.ts` | ChatGPT OAuth, OIDC validation, private credentials, and automatic refresh |
| `src/chatgpt-model.ts` | ChatGPT model catalog, Responses streaming, and tool call adapter |
| `src/slack.ts` | Slack Socket Mode, user allowlist, conversation routing, and message delivery |
| `src/slack-session.ts` | Slack session file mapping, automatic recovery, and archiving |
| `src/qoder.ts` | Qoder PAT exchange, model discovery, COSY signing, and stream parsing |
| `src/session.ts` | Atomic session writes and restoration |
| `src/cli.ts` | Command-line entry point |

Tests use simulated models and ChatGPT authorization and responses, plus simulated Qoder responses. They do not use real credentials.
