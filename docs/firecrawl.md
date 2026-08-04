# Connect Pi to Michael's Firecrawl server

Pi's `firecrawl-web` extension uses Michael's self-hosted Firecrawl deployment at:

```text
https://firecrawl.michaelyklam.me
```

The repository does not contain the bearer token. Obtain the companion
`Firecrawl-external-agent.env` file through a private channel.

## Install the credentials

Place the credentials in Pi's private configuration directory:

```bash
config_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
install -d -m 700 "$config_dir"
install -m 600 \
  /secure/path/Firecrawl-external-agent.env \
  "$config_dir/firecrawl.env"
```

The file must contain:

```bash
FIRECRAWL_API_URL=https://firecrawl.michaelyklam.me
FIRECRAWL_API_KEY=<private bearer token>
```

Do not commit this file, paste its token into prompts, or include the token in
logs. The extension rejects a credentials file that is accessible by group or
other users.

The credentials file takes precedence over inherited environment variables.
This prevents an obsolete shell-level `FIRECRAWL_API_KEY` from redirecting Pi.
If the file is absent, the extension falls back to `FIRECRAWL_API_URL` and
`FIRECRAWL_API_KEY` from Pi's process environment. If neither source is
configured, it uses Firecrawl's rate-limited keyless cloud tier.

Run `/reload` after installing or replacing the file. Restart Pi if shell-level
environment variables were also changed.

## Verify connectivity

Load the credentials without printing them, then call the health endpoint:

```bash
set -a
. "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/firecrawl.env"
set +a

curl --fail-with-body \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  "$FIRECRAWL_API_URL/"
```

A successful request returns HTTP 200 and a small health response. Missing or
incorrect credentials return HTTP 401.

After reloading Pi, verify both tools:

- Ask Pi to use `web_search` for a current topic.
- Ask Pi to use `web_fetch` on `https://example.com`.

## API endpoints

External agents can connect to the same deployment by setting the two
configuration variables and sending the key as a bearer token.

| Operation | Endpoint |
|---|---|
| Health | `GET /` |
| Search | `POST /v2/search` |
| Scrape | `POST /v2/scrape` |

Example scrape request:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown"]}' \
  "$FIRECRAWL_API_URL/v2/scrape"
```

The self-hosted search backend is less reliable than direct DDGS. Prefer
Firecrawl for extraction and crawling when another agent has a dedicated DDGS
search backend. Pi may continue using `web_search` because it does not have a
separate built-in web-search provider.
