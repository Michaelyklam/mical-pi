# Comment on Linear Ticket Skill

## Purpose
Leave comments on Linear issues using the GraphQL API. All comments are automatically prefixed with "AI Triage Agent:" to differentiate them from human-created comments.

## When to Use
Use this skill when the user requests to:
- Leave a comment on a Linear issue
- Add notes or updates to a Linear ticket
- Post information to a Linear issue
- Reply to or update a Linear issue

## Prerequisites
- Linear API key stored in `.claude/secrets.json` under `linear.apiKey`
- The API key must have `write` or `comments:create` scope
- Issue ID in the format `TEAM-123` (e.g., `USLAB-66`, `ENG-42`)

## Important Rules

### Comment Prefix Requirement
**ALL comments MUST be prefixed with "AI Triage Agent:"**

This is required to:
- Differentiate AI-generated comments from human comments
- Provide transparency about the comment source
- Help users identify automated updates

**Example:**
- User requests: "Comment 'Bug fixed' on USLAB-66"
- Actual comment body: "AI Triage Agent: Bug fixed"

## Process

### Step 1: Read the Linear API Key
Read the API key from the secrets file:

```bash
# API key is stored at: .claude/secrets.json
# Format: { "linear": { "apiKey": "lin_api_..." } }
```

### Step 2: Prepare the Comment Body
Take the user's requested comment text and prefix it with "AI Triage Agent:":

```
Original text: "test successful"
Final body: "AI Triage Agent: test successful"
```

### Step 3: Create the GraphQL Mutation
Create a temporary JSON file with the GraphQL mutation:

```bash
cat > /tmp/linear_comment.json << 'EOF'
{
  "query": "mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: {issueId: $issueId, body: $body}) { success comment { id body } } }",
  "variables": {
    "issueId": "ISSUE_ID",
    "body": "AI Triage Agent: COMMENT_TEXT"
  }
}
EOF
```

**Important:**
- Replace `ISSUE_ID` with the actual issue identifier (e.g., "USLAB-66")
- Replace `COMMENT_TEXT` with the user's comment text
- **Always include "AI Triage Agent:" prefix in the body**
- Use heredoc syntax to avoid JSON escaping issues

### Step 4: Execute the GraphQL Request
Send the mutation to Linear's GraphQL API:

```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/linear_comment.json
```

**Successful Response:**
```json
{
  "data": {
    "commentCreate": {
      "success": true,
      "comment": {
        "id": "f48a2334-3d1d-4270-93c2-958d98d7b81d",
        "body": "AI Triage Agent: test successful"
      }
    }
  }
}
```

### Step 5: Confirm Success
After successful creation, inform the user:
- The comment was posted successfully
- The issue ID where it was posted
- The comment ID returned by Linear

## Error Handling

### Invalid Scope Error
If the API returns a 403 error with "Invalid scope":
```json
{
  "errors": [{
    "message": "Invalid scope: `write` or `comments:create` required"
  }]
}
```
- Inform the user that the API key lacks permission to create comments
- The API key needs to be regenerated with `write` or `comments:create` scope

### Issue Not Found
If the API returns an error about the issue not existing:
- Verify the issue ID format is correct (TEAM-NUMBER)
- Confirm the issue exists in Linear
- Check that the API key has access to the team/workspace

### JSON Parsing Error
If you get "Bad escaped character in JSON":
- Use the heredoc approach (`cat > /tmp/file << 'EOF'`)
- Do NOT try to escape JSON in the curl command directly
- Always use `-d @/tmp/linear_comment.json`

## Examples

### Example 1: Simple Comment
```
User: Leave a comment on USLAB-66 saying "Bug reproduced successfully"

Process:
1. Read API key from secrets.json
2. Prepare body: "AI Triage Agent: Bug reproduced successfully"
3. Create mutation with issueId: "USLAB-66"
4. Execute GraphQL request
5. Confirm: "Comment posted to USLAB-66"
```

### Example 2: Multi-line Comment
```
User: Comment on ENG-123: "Analysis complete. Found 3 issues:
1. Memory leak in handler
2. Race condition in cache
3. Missing error handling"

Body becomes:
"AI Triage Agent: Analysis complete. Found 3 issues:
1. Memory leak in handler
2. Race condition in cache
3. Missing error handling"
```

### Example 3: Status Update
```
User: Update USLAB-50 that the fix has been deployed to staging

Body becomes:
"AI Triage Agent: The fix has been deployed to staging"
```

## GraphQL API Reference

### commentCreate Mutation

**Endpoint**: `https://api.linear.app/graphql`

**Headers**:
- `Authorization: {LINEAR_API_KEY}`
- `Content-Type: application/json`

**Query**:
```graphql
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) {
    success
    comment {
      id
      body
    }
  }
}
```

**Variables**:
- `issueId` (String, required): The issue identifier (e.g., "USLAB-66")
- `body` (String, required): The comment text (must include "AI Triage Agent:" prefix)

**Response Fields**:
- `success` (Boolean): Whether the comment was created successfully
- `comment.id` (String): Unique identifier for the created comment
- `comment.body` (String): The full comment text as stored

## Security Notes
- Never log or display the full API key
- The API key is sensitive and should only be read from secrets.json
- Always use HTTPS for API calls
- Store temporary JSON files in /tmp for automatic cleanup

## Reminders
- ✅ **ALWAYS** prefix comments with "AI Triage Agent:"
- ✅ Use heredoc for JSON to avoid escaping issues
- ✅ Use `/tmp/linear_comment.json` for the mutation payload
- ✅ Verify the issue ID format (TEAM-NUMBER)
- ✅ Read the API key from `.claude/secrets.json`
