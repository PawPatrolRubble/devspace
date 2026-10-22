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

## Self-hosted Ubuntu + Nginx SSH relay (no Tailscale)

Use your existing HTTPS server as the public MCP entry point. DevSpace creates an
outbound SSH connection from the local workstation, forwards a loopback-only
port on Ubuntu, and reconnects when the connection drops.

Data path: ChatGPT -> https://devspace.example.com -> Nginx on Ubuntu ->
127.0.0.1:17676 (Ubuntu SSH forwarding listener) -> SSH ->
127.0.0.1:7676 (your local DevSpace).

### 1. Prepare a dedicated Ubuntu SSH account and key

On the workstation, generate a dedicated SSH identity:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/devspace_relay
```

Install the PUBLIC key in the Ubuntu account's `~/.ssh/authorized_keys`.
Connect interactively once to verify the server host-key fingerprint:

```bash
ssh -i ~/.ssh/devspace_relay devrelay@YOUR_SERVER_IP
```

Check the SSH fingerprint with the server administrator first. This records
the verified host key in `known_hosts`. The relay uses strict host-key
verification and noninteractive key authentication; it will not accept
unrecognized host keys. Ubuntu OpenSSH must allow remote TCP forwarding
(`AllowTcpForwarding yes`). Do not enable public gateway binding.

### 2. Configure ~/.devspace/config.json on the workstation

```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "publicBaseUrl": "https://devspace.example.com",
  "allowedRoots": ["C:/projects"],
  "relay": {
    "host": "YOUR_SERVER_IP",
    "user": "devrelay",
    "sshPort": 22,
    "remotePort": 17676,
    "identityFile": "~/.ssh/devspace_relay"
  }
}
```

Replace the public HTTPS domain, project directory, Ubuntu IP and account.
SSH host and HTTPS domain can be different. The public URL is the HTTPS
origin only (do not append `/mcp`).

### 3. Configure the HTTPS site in Ubuntu Nginx

DNS for `devspace.example.com` must resolve to your Ubuntu server. Adjust
the TLS certificate paths to match your existing certificate deployment.

```nginx
server {
    listen 443 ssl;
    server_name devspace.example.com;

    ssl_certificate /etc/letsencrypt/live/devspace.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/devspace.example.com/privkey.pem;

    # Dashboard routes are not OAuth-protected on older forks.
    location = /app { return 403; }
    location ^~ /app/ { return 403; }

    # Include OAuth discovery and authorization paths, not just /mcp.
    location / {
        proxy_pass http://127.0.0.1:17676;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Validate with `sudo nginx -t && sudo systemctl reload nginx`.
The SSH forwarded port is bound on Ubuntu **only** at `127.0.0.1:17676`.
Do not expose TCP 17676 to the Internet; public clients use HTTPS 443.

### 4. Start the relay

```bash
devspace serve --relay
```

DevSpace starts its local MCP listener before launching `ssh`. The relay
uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ExitOnForwardFailure=yes`
and 30-second keepalives. SSH exit triggers bounded exponential reconnects
(up to 30 seconds). Stop DevSpace to terminate the SSH child process.
Use `--relay` **instead of**, not together with, `--tunnel`.

On Ubuntu test `curl http://127.0.0.1:17676/healthz`, then connect your
MCP client to `https://devspace.example.com/mcp` and approve OAuth.

**Security:** SSH is a transport, not an execution sandbox. Restrict allowed
workspace roots, keep your Owner password private, and block `/app` in Nginx.
