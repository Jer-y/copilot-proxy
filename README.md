English | [简体中文](README.zh-CN.md)

# Copilot API Proxy

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

---

**Note:** If you are using [opencode](https://github.com/sst/opencode), you do not need this project. Opencode supports GitHub Copilot provider out of the box.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI- and Anthropic-compatible service. This lets you use GitHub Copilot with tools that support OpenAI Chat Completions/Responses or Anthropic Messages, including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) and OpenAI Codex.

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Responses API Support**: Supports the OpenAI Responses API (`/v1/responses`) for thinking-mode models like `gpt-5`, `gpt-5.1-codex`, `gpt-5.2-codex`, `o3-mini`, and `o4-mini`.
- **Codex Ready**: Works with OpenAI Codex CLI/SDK by pointing its base URL to this proxy.
- **Model-Aware Translation**: Automatically applies model-specific optimizations — prompt caching (`copilot_cache_control`) for Claude models, `reasoning_effort` mapping from Anthropic's `thinking.budget_tokens`, and intelligent model name normalization (e.g., `claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`).
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.

## Prerequisites

- Bun (>= 1.2.x)
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

### Install the CLI (global)

Pick your package manager:

```sh
# npm
npm i -g @jer-y/copilot-proxy

# pnpm
pnpm add -g @jer-y/copilot-proxy

# yarn (classic)
yarn global add @jer-y/copilot-proxy

# bun
bun add -g @jer-y/copilot-proxy

# volta (optional)
volta install @jer-y/copilot-proxy
```

Then run:

```sh
copilot-proxy start
```

### Run without installing (one-off)

```sh
# npx
npx @jer-y/copilot-proxy@latest start

# pnpm dlx
pnpm dlx @jer-y/copilot-proxy@latest start

# yarn dlx
yarn dlx @jer-y/copilot-proxy@latest start

# bunx
bunx @jer-y/copilot-proxy@latest start
```

### Install from source (development)

To install dependencies locally, run:

```sh
bun install
```

## Using with Docker

Build image

```sh
docker build -t copilot-proxy .
```

Run the container

```sh
# Create a directory on your host to persist the GitHub token and related data
mkdir -p ./copilot-data

# Run the container with a bind mount to persist the token
# This ensures your authentication survives container restarts

docker run -p 4399:4399 -v $(pwd)/copilot-data:/root/.local/share/copilot-proxy copilot-proxy
```

> **Note:**
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-proxy` inside the container, ensuring persistence across restarts.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-proxy .

# Run with GitHub token
docker run -p 4399:4399 -e GH_TOKEN=your_github_token_here copilot-proxy

# Run with additional options
docker run -p 4399:4399 -e GH_TOKEN=your_token copilot-proxy start --verbose --port 4399
```

### Docker Compose Example

```yaml
version: '3.8'
services:
  copilot-proxy:
    build: .
    ports:
      - '4399:4399'
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Pinned base image version for reproducible builds

## Using with npx (or pnpm/bunx)

You can run the project directly using npx:

```sh
npx @jer-y/copilot-proxy@latest start
```

With options:

```sh
npx @jer-y/copilot-proxy@latest start --port 8080
```

For authentication only:

```sh
npx @jer-y/copilot-proxy@latest auth
```

> Tip: If you prefer pnpm/bun/yarn, replace `npx` with `pnpm dlx`, `bunx`, or `yarn dlx`.

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Run GitHub authentication flow without starting the server. This is typically used if you need to generate a token for use with the `--github-token` option, especially in non-interactive environments.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.

## Command Line Options

### Start Command Options

The following command line options are available for the `start` command:

| Option         | Description                                                                   | Default    | Alias |
| -------------- | ----------------------------------------------------------------------------- | ---------- | ----- |
| --port         | Port to listen on                                                             | 4399       | -p    |
| --verbose      | Enable verbose logging                                                        | false      | -v    |
| --account-type | Account type to use (individual, business, enterprise)                        | individual | -a    |
| --manual       | Enable manual request approval                                                | false      | none  |
| --rate-limit   | Rate limit in seconds between requests                                        | none       | -r    |
| --wait         | Wait instead of error when rate limit is hit                                  | false      | -w    |
| --github-token | Provide GitHub token directly (must be generated using the `auth` subcommand) | none       | -g    |
| --claude-code  | Generate a command to launch Claude Code with Copilot API config              | false      | -c    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |

### Auth Command Options

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --verbose    | Enable verbose logging    | false   | -v    |
| --show-token | Show GitHub token on auth | false   | none  |

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

## API Endpoints

The server exposes several endpoints to interact with the Copilot API. It provides OpenAI-compatible endpoints and Anthropic-compatible endpoints, allowing for greater flexibility with different tools and services. All endpoints are available with or without the `/v1/` prefix.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation. |
| `GET /v1/models`            | `GET`  | Lists the currently available models.                     |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.  |

### OpenAI Responses API Endpoint

This endpoint supports the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) format, used by thinking-mode models such as `gpt-5`, `gpt-5.1-codex`, `gpt-5.2-codex`, `o3-mini`, and `o4-mini`. Requests are forwarded directly to Copilot's `/responses` endpoint.

| Endpoint              | Method | Description                                                              |
| --------------------- | ------ | ------------------------------------------------------------------------ |
| `POST /v1/responses`  | `POST` | Creates a model response using the Responses API (supports streaming).   |

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API. Incoming Anthropic-format requests are automatically translated to the OpenAI format before being sent to Copilot, and responses are translated back.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. |

### Usage Monitoring Endpoints

Endpoints for monitoring your Copilot usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |
| `GET /token` | `GET`  | Get the current Copilot token being used by the API.         |

## Example Usage

Using with npx (replace with `pnpm dlx`, `bunx`, or `yarn dlx` if preferred):

```sh
# Basic usage with start command
npx @jer-y/copilot-proxy@latest start

# Run on custom port with verbose logging
npx @jer-y/copilot-proxy@latest start --port 8080 --verbose

# Use with a business plan GitHub account
npx @jer-y/copilot-proxy@latest start --account-type business

# Use with an enterprise plan GitHub account
npx @jer-y/copilot-proxy@latest start --account-type enterprise

# Enable manual approval for each request
npx @jer-y/copilot-proxy@latest start --manual

# Set rate limit to 30 seconds between requests
npx @jer-y/copilot-proxy@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx @jer-y/copilot-proxy@latest start --rate-limit 30 --wait

# Provide GitHub token directly
npx @jer-y/copilot-proxy@latest start --github-token ghp_YOUR_TOKEN_HERE

# Run only the auth flow
npx @jer-y/copilot-proxy@latest auth

# Run auth flow with verbose logging
npx @jer-y/copilot-proxy@latest auth --verbose

# Show your Copilot usage/quota in the terminal (no server needed)
npx @jer-y/copilot-proxy@latest check-usage

# Display debug information for troubleshooting
npx @jer-y/copilot-proxy@latest debug

# Display debug information in JSON format
npx @jer-y/copilot-proxy@latest debug --json

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
npx @jer-y/copilot-proxy@latest start --proxy-env
```

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example, using npx:
    ```sh
    npx @jer-y/copilot-proxy@latest start
    ```
2.  The server will output a URL to the usage viewer. Copy and paste this URL into your browser. It will look something like this:
    `https://jer-y.github.io/copilot-proxy?endpoint=http://localhost:4399/usage`
    - If you use the `start.bat` script on Windows, this page will open automatically.

The dashboard provides a user-friendly interface to view your Copilot usage data:

- **API Endpoint URL**: The dashboard is pre-configured to fetch data from your local server endpoint via the URL query parameter. You can change this URL to point to any other compatible API endpoint.
- **Fetch Data**: Click the "Fetch" button to load or refresh the usage data. The dashboard will automatically fetch data on load.
- **Usage Quotas**: View a summary of your usage quotas for different services like Chat and Completions, displayed with progress bars for a quick overview.
- **Detailed Information**: See the full JSON response from the API for a detailed breakdown of all available usage statistics.
- **URL-based Configuration**: You can also specify the API endpoint directly in the URL using a query parameter. This is useful for bookmarks or sharing links. For example:
  `https://jer-y.github.io/copilot-proxy?endpoint=http://your-api-server/usage`

## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
npx @jer-y/copilot-proxy@latest start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4399",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Running from Source

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev
```

### Production Mode

```sh
bun run start
```

## Usage Tips

- To avoid hitting GitHub Copilot's rate limits, you can use the following flags:
  - `--manual`: Enables manual approval for each request, giving you full control over when requests are sent.
  - `--rate-limit <seconds>`: Enforces a minimum time interval between requests. For example, `copilot-proxy start --rate-limit 30` will ensure there's at least a 30-second gap between requests.
  - `--wait`: Use this with `--rate-limit`. It makes the server wait for the cooldown period to end instead of rejecting the request with an error. This is useful for clients that don't automatically retry on rate limit errors.
- If you have a GitHub business or enterprise plan account with Copilot, use the `--account-type` flag (e.g., `--account-type business`). See the [official documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.

## Acknowledgments

This project is forked from [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api). This repository was created for personal use.
