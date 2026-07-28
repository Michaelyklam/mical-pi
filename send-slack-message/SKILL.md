# Send Slack Message Skill

## Purpose
Send direct messages to Verkada employees via Slack using the VBugCheck bot. This skill handles user lookup and message delivery.

## When to Use
Use this skill when the user requests to send a Slack message or DM to someone at Verkada.

## Prerequisites
- Slack bot token stored in `.claude/secrets.json` under `slack.slackBotKey`
- The bot must have the following scopes:
  - `chat:write` (for sending messages)
  - `users:read` (for looking up users)
  - `users:read.email` (for looking up users by email)

## Process

### Step 1: Read the Slack Bot Token
Read the bot token from the secrets file:

```bash
# Token is stored at: .claude/secrets.json
# Format: { "slack": { "slackBotKey": "xoxb-..." } }
```

### Step 2: Look Up User by Email
Use the Slack API to find the user's ID by their email address:

```bash
curl -X GET "https://slack.com/api/users.lookupByEmail?email=USER_EMAIL" \
  -H "Authorization: Bearer SLACK_BOT_TOKEN"
```

**Response format:**
```json
{
  "ok": true,
  "user": {
    "id": "U04L3NV8S23",
    "name": "john.doe",
    "real_name": "John Doe",
    "profile": {
      "email": "john.doe@verkada.com",
      ...
    }
  }
}
```

**Extract the `user.id` field** - this is the Slack user ID needed for sending the message.

### Step 3: Send the Direct Message
Use the `chat.postMessage` API endpoint with application/x-www-form-urlencoded format:

```bash
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer SLACK_BOT_TOKEN" \
  -d "channel=USER_ID" \
  -d "text=MESSAGE_TEXT"
```

**Important Notes:**
- Use `-d` for form data (NOT `-d '{"json":"data"}'`)
- The `channel` parameter accepts a user ID for DMs
- The `text` parameter is the message content
- DO NOT use `Content-Type: application/json` - use form encoding instead

**Successful Response:**
```json
{
  "ok": true,
  "channel": "D09H986KTQT",
  "ts": "1763069275.254459",
  "message": {
    "text": "your message here",
    "bot_profile": {
      "name": "VBugCheck"
    }
  }
}
```

### Step 4: Confirm Delivery
After successful delivery, inform the user:
- The message was sent successfully
- The recipient's name and email
- The channel ID where it was delivered

## Error Handling

### User Not Found
If `users.lookupByEmail` returns `"ok": false`:
- Inform the user that the email address was not found
- Suggest checking the email format (must be @verkada.com)

### Message Send Failed
If `chat.postMessage` returns `"ok": false`:
- Check the `error` field in the response
- Common errors:
  - `invalid_json`: Use form encoding, not JSON
  - `channel_not_found`: User ID is invalid
  - `missing_scope`: Bot lacks required permissions

## Examples

### Example 1: Simple Message
```
User: Send a message to john.doe@verkada.com saying "Hello from Claude!"

Process:
1. Look up user: john.doe@verkada.com → U04L3NV8S23
2. Send message: "Hello from Claude!" to U04L3NV8S23
3. Confirm: "Message sent successfully to John Doe"
```

### Example 2: Multiple Recipients
```
User: Send "Meeting at 3pm" to alice@verkada.com and bob@verkada.com

Process:
1. Look up alice@verkada.com → U12345678
2. Send message to U12345678
3. Look up bob@verkada.com → U87654321
4. Send message to U87654321
5. Confirm both deliveries
```

## API Reference

### users.lookupByEmail
- **Method**: GET
- **URL**: `https://slack.com/api/users.lookupByEmail`
- **Parameters**: `?email=USER_EMAIL`
- **Headers**: `Authorization: Bearer SLACK_BOT_TOKEN`
- **Required Scopes**: `users:read`, `users:read.email`

### chat.postMessage
- **Method**: POST
- **URL**: `https://slack.com/api/chat.postMessage`
- **Headers**: `Authorization: Bearer SLACK_BOT_TOKEN`
- **Body Format**: application/x-www-form-urlencoded
- **Parameters**:
  - `channel`: User ID (for DMs) or channel ID
  - `text`: Message text
- **Required Scopes**: `chat:write`

## Security Notes
- Never log or display the bot token
- The bot token is sensitive and should only be read from secrets.json
- Always use HTTPS for API calls
- The VBugCheck bot will appear as the sender of all messages
