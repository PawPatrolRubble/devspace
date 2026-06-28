# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through DevSpace.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- Tailscale with Funnel enabled, or another public HTTPS URL that forwards to the
  local DevSpace server

DevSpace can configure Tailscale Funnel when started with `--tunnel`. You can
also use ngrok, Pinggy, Cloudflare Tunnel, or your own HTTPS reverse proxy.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through DevSpace. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

With Tailscale Funnel, you can let DevSpace configure this when it starts:

```bash
npx @waishnav/devspace serve --tunnel
```

For another tunnel or reverse proxy, start it before entering this value. Point
the tunnel at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-machine.your-tailnet.ts.net
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-machine.your-tailnet.ts.net/mcp
```

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

To configure Tailscale Funnel automatically and persist the discovered public
URL, run:

```bash
npx @waishnav/devspace serve --tunnel
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-machine.your-tailnet.ts.net" npx @waishnav/devspace serve
```

For a stable public URL, persist it:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
