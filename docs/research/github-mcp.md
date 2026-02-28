# GitHub MCP Tools Schema Documentation

This document provides a comprehensive schema reference for all GitHub MCP (Model Context Protocol) tools available in the system.

## Table of Contents

1. [Authentication & User Info](#authentication--user-info)
2. [Repository Management](#repository-management) 
3. [Branch & Commit Management](#branch--commit-management)
4. [File Management](#file-management)
5. [Issue Management](#issue-management)
6. [Pull Request Management](#pull-request-management)
7. [Review Management](#review-management)
8. [Release & Tag Management](#release--tag-management)
9. [Search & Discovery](#search--discovery)
10. [Copilot Integration](#copilot-integration)

---

## Authentication & User Info

### mcp_github_get_me

Get details of the authenticated GitHub user.

**Parameters:** None

**Example Response:**
```json
{
  "login": "username",
  "id": 12345,
  "name": "User Name",
  "email": "user@example.com",
  "bio": "User bio",
  "company": "Company Name",
  "location": "City, Country",
  "public_repos": 42,
  "followers": 100,
  "following": 50
}
```

---

## Repository Management

### mcp_github_create_repository

Create a new GitHub repository in your account or specified organization.

**Parameters:**
- `name` (string, required): Repository name
- `description` (string, optional): Repository description
- `private` (boolean, optional): Whether repo should be private
- `autoInit` (boolean, optional): Initialize with README
- `organization` (string, optional): Organization to create the repository in

**Example Response:**
```json
{
  "id": 123456,
  "name": "my-repo",
  "full_name": "username/my-repo", 
  "private": false,
  "html_url": "https://github.com/username/my-repo",
  "clone_url": "https://github.com/username/my-repo.git"
}
```

### mcp_github_fork_repository

Fork a GitHub repository to your account or specified organization.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `organization` (string, optional): Organization to fork to

**Example Response:**
```json
{
  "id": 234567,
  "name": "forked-repo",
  "full_name": "username/forked-repo",
  "fork": true,
  "parent": {
    "full_name": "original-owner/repo"
  }
}
```

---

## Branch & Commit Management

### mcp_github_create_branch

Create a new branch in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `branch` (string, required): Name for new branch
- `from_branch` (string, optional): Source branch (defaults to repo default)

**Example Response:**
```json
{
  "ref": "refs/heads/new-branch",
  "sha": "abc123...",
  "object": {
    "type": "commit"
  }
}
```

### mcp_github_list_branches

List branches in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `page` (number, optional): Page number for pagination (min 1)
- `perPage` (number, optional): Results per page (min 1, max 100)

**Example Response:**
```json
[
  {
    "name": "main",
    "commit": {
      "sha": "abc123...",
      "url": "https://api.github.com/repos/owner/repo/commits/abc123"
    },
    "protected": true
  }
]
```

### mcp_github_list_commits

Get list of commits of a branch in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `sha` (string, optional): Commit SHA, branch or tag name
- `author` (string, optional): Author username or email address
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page (min 1, max 100)

**Example Response:**
```json
[
  {
    "sha": "abc123...",
    "commit": {
      "message": "Commit message",
      "author": {
        "name": "Author Name",
        "email": "author@example.com",
        "date": "2023-01-01T00:00:00Z"
      }
    },
    "author": {
      "login": "username",
      "id": 12345
    }
  }
]
```

### mcp_github_get_commit

Get details for a commit from a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `sha` (string, required): Commit SHA, branch name, or tag name
- `include_diff` (boolean, optional): Include file diffs and stats (default: true)
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
{
  "sha": "abc123...",
  "commit": {
    "message": "Commit message",
    "tree": {
      "sha": "def456..."
    }
  },
  "files": [
    {
      "filename": "file.js",
      "status": "modified",
      "additions": 5,
      "deletions": 2,
      "patch": "@@ -1,3 +1,6 @@..."
    }
  ],
  "stats": {
    "additions": 5,
    "deletions": 2,
    "total": 7
  }
}
```

---

## File Management

### mcp_github_get_file_contents

Get the contents of a file or directory from a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `path` (string, optional): Path to file/directory (default: "/")
- `ref` (string, optional): Git refs like `refs/tags/{tag}`, `refs/heads/{branch}`
- `sha` (string, optional): Commit SHA (overrides ref)

**Example Response:**
```json
{
  "name": "README.md",
  "path": "README.md",
  "sha": "abc123...",
  "size": 1024,
  "content": "base64-encoded-content",
  "encoding": "base64",
  "download_url": "https://raw.githubusercontent.com/...",
  "type": "file"
}
```

### mcp_github_create_or_update_file

Create or update a single file in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `path` (string, required): Path where to create/update the file
- `content` (string, required): Content of the file
- `message` (string, required): Commit message
- `branch` (string, required): Branch to create/update the file in
- `sha` (string, optional): The blob SHA of the file being replaced

**Example Response:**
```json
{
  "content": {
    "name": "file.txt",
    "path": "path/to/file.txt",
    "sha": "new-sha...",
    "size": 100
  },
  "commit": {
    "sha": "commit-sha...",
    "message": "Create file.txt"
  }
}
```

### mcp_github_delete_file

Delete a file from a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `path` (string, required): Path to the file to delete
- `message` (string, required): Commit message
- `branch` (string, required): Branch to delete the file from

**Example Response:**
```json
{
  "commit": {
    "sha": "commit-sha...",
    "message": "Delete file.txt"
  }
}
```

### mcp_github_push_files

Push multiple files to a GitHub repository in a single commit.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `branch` (string, required): Branch to push to
- `message` (string, required): Commit message
- `files` (array, required): Array of file objects with:
  - `path` (string, required): File path
  - `content` (string, required): File content

**Example Response:**
```json
{
  "sha": "commit-sha...",
  "message": "Add multiple files",
  "tree": {
    "sha": "tree-sha..."
  }
}
```

---

## Issue Management

### mcp_github_issue_write

Create a new or update an existing issue in a GitHub repository.

**Parameters:**
- `method` (string, required): "create" or "update"
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `issue_number` (number, optional): Issue number to update (for update method)
- `title` (string, optional): Issue title
- `body` (string, optional): Issue body content
- `assignees` (array, optional): Usernames to assign
- `labels` (array, optional): Labels to apply
- `milestone` (number, optional): Milestone number
- `state` (string, optional): "open" or "closed"
- `state_reason` (string, optional): "completed", "not_planned", "duplicate"
- `duplicate_of` (number, optional): Issue number this is duplicate of
- `type` (string, optional): Issue type (if repository supports it)

**Example Response:**
```json
{
  "id": 123456,
  "number": 42,
  "title": "Issue title",
  "body": "Issue description",
  "state": "open",
  "assignees": [],
  "labels": [
    {
      "name": "bug",
      "color": "d73a4a"
    }
  ],
  "html_url": "https://github.com/owner/repo/issues/42"
}
```

### mcp_github_issue_read

Get information about a specific issue in a GitHub repository.

**Parameters:**
- `method` (string, required): "get", "get_comments", "get_sub_issues", "get_labels"
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `issue_number` (number, required): Issue number
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response (get method):**
```json
{
  "id": 123456,
  "number": 42,
  "title": "Issue title",
  "body": "Issue description",
  "state": "open",
  "user": {
    "login": "username"
  },
  "created_at": "2023-01-01T00:00:00Z",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### mcp_github_list_issues

List issues in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `state` (string, optional): "OPEN", "CLOSED"
- `labels` (array, optional): Filter by labels
- `orderBy` (string, optional): "CREATED_AT", "UPDATED_AT", "COMMENTS"
- `direction` (string, optional): "ASC", "DESC"
- `since` (string, optional): ISO 8601 timestamp filter
- `after` (string, optional): Cursor for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
{
  "data": {
    "issues": [
      {
        "number": 42,
        "title": "Issue title",
        "state": "OPEN",
        "createdAt": "2023-01-01T00:00:00Z"
      }
    ],
    "pageInfo": {
      "hasNextPage": true,
      "endCursor": "cursor-string"
    }
  }
}
```

### mcp_github_search_issues

Search for issues in GitHub repositories.

**Parameters:**
- `query` (string, required): Search query using GitHub issues search syntax
- `owner` (string, optional): Repository owner filter
- `repo` (string, optional): Repository name filter
- `sort` (string, optional): Sort field
- `order` (string, optional): "asc" or "desc"
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
{
  "total_count": 100,
  "items": [
    {
      "number": 42,
      "title": "Issue title",
      "state": "open",
      "repository_url": "https://api.github.com/repos/owner/repo"
    }
  ]
}
```

### mcp_github_add_issue_comment

Add a comment to a specific issue in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `issue_number` (number, required): Issue number
- `body` (string, required): Comment content

**Example Response:**
```json
{
  "id": 987654,
  "body": "Comment text",
  "user": {
    "login": "username"
  },
  "created_at": "2023-01-01T00:00:00Z",
  "html_url": "https://github.com/owner/repo/issues/42#issuecomment-987654"
}
```

### mcp_github_sub_issue_write

Manage sub-issues within a parent issue.

**Parameters:**
- `method` (string, required): "add", "remove", "reprioritize"
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `issue_number` (number, required): Parent issue number
- `sub_issue_id` (number, required): Sub-issue ID to manage
- `replace_parent` (boolean, optional): Replace current parent (for add method)
- `after_id` (number, optional): Position after this sub-issue (for reprioritize)
- `before_id` (number, optional): Position before this sub-issue (for reprioritize)

**Example Response:**
```json
{
  "success": true,
  "message": "Sub-issue added successfully"
}
```

### mcp_github_list_issue_types

List supported issue types for repository owner (organization).

**Parameters:**
- `owner` (string, required): Organization owner

**Example Response:**
```json
[
  {
    "name": "Bug",
    "description": "Something isn't working"
  },
  {
    "name": "Feature",
    "description": "New feature request"
  }
]
```

---

## Pull Request Management

### mcp_github_create_pull_request

Create a new pull request in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `title` (string, required): PR title
- `head` (string, required): Branch containing changes
- `base` (string, required): Branch to merge into
- `body` (string, optional): PR description
- `draft` (boolean, optional): Create as draft PR
- `maintainer_can_modify` (boolean, optional): Allow maintainer edits

**Example Response:**
```json
{
  "id": 345678,
  "number": 15,
  "title": "Add new feature",
  "state": "open",
  "draft": false,
  "head": {
    "ref": "feature-branch",
    "sha": "abc123..."
  },
  "base": {
    "ref": "main"
  },
  "html_url": "https://github.com/owner/repo/pull/15"
}
```

### mcp_github_list_pull_requests

List pull requests in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `state` (string, optional): "open", "closed", "all"
- `head` (string, optional): Filter by head user/org and branch
- `base` (string, optional): Filter by base branch
- `sort` (string, optional): "created", "updated", "popularity", "long-running"
- `direction` (string, optional): "asc" or "desc"
- `page` (number, optional): Page number
- `perPage` (number, optional): Results per page

**Example Response:**
```json
[
  {
    "number": 15,
    "title": "Add new feature",
    "state": "open",
    "user": {
      "login": "username"
    },
    "created_at": "2023-01-01T00:00:00Z"
  }
]
```

### mcp_github_pull_request_read

Get information on a specific pull request.

**Parameters:**
- `method` (string, required): "get", "get_diff", "get_status", "get_files", "get_review_comments", "get_reviews", "get_comments"
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response (get method):**
```json
{
  "number": 15,
  "title": "Add new feature",
  "body": "PR description",
  "state": "open",
  "mergeable": true,
  "merged": false,
  "head": {
    "ref": "feature-branch",
    "sha": "abc123..."
  },
  "base": {
    "ref": "main"
  }
}
```

### mcp_github_update_pull_request

Update an existing pull request in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `title` (string, optional): New title
- `body` (string, optional): New description
- `base` (string, optional): New base branch
- `state` (string, optional): "open" or "closed"
- `draft` (boolean, optional): Draft status
- `maintainer_can_modify` (boolean, optional): Allow maintainer edits
- `reviewers` (array, optional): GitHub usernames to request reviews

**Example Response:**
```json
{
  "number": 15,
  "title": "Updated title",
  "state": "open",
  "updated_at": "2023-01-01T00:00:00Z"
}
```

### mcp_github_merge_pull_request

Merge a pull request in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `commit_title` (string, optional): Title for merge commit
- `commit_message` (string, optional): Extra detail for merge commit
- `merge_method` (string, optional): "merge", "squash", "rebase"

**Example Response:**
```json
{
  "sha": "merge-commit-sha...",
  "merged": true,
  "message": "Pull Request successfully merged"
}
```

### mcp_github_update_pull_request_branch

Update the branch of a pull request with the latest changes from the base branch.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `expectedHeadSha` (string, optional): Expected SHA of PR's HEAD ref

**Example Response:**
```json
{
  "message": "Updating pull request branch.",
  "url": "https://github.com/owner/repo/pull/15"
}
```

### mcp_github_search_pull_requests

Search for pull requests in GitHub repositories.

**Parameters:**
- `query` (string, required): Search query using GitHub PR search syntax
- `owner` (string, optional): Repository owner filter
- `repo` (string, optional): Repository name filter
- `sort` (string, optional): Sort field
- `order` (string, optional): "asc" or "desc"
- `page` (number, optional): Page number
- `perPage` (number, optional): Results per page

**Example Response:**
```json
{
  "total_count": 50,
  "items": [
    {
      "number": 15,
      "title": "Add new feature",
      "state": "open",
      "pull_request": {
        "url": "https://api.github.com/repos/owner/repo/pulls/15"
      }
    }
  ]
}
```

---

## Review Management

### mcp_github_pull_request_review_write

Create, submit, or delete pull request reviews.

**Parameters:**
- `method` (string, required): "create", "submit_pending", "delete_pending"
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `body` (string, optional): Review comment text
- `event` (string, optional): "APPROVE", "REQUEST_CHANGES", "COMMENT"
- `commitID` (string, optional): SHA of commit to review

**Example Response:**
```json
{
  "id": 456789,
  "body": "Looks good to me!",
  "state": "APPROVED",
  "user": {
    "login": "reviewer"
  },
  "submitted_at": "2023-01-01T00:00:00Z"
}
```

### mcp_github_add_comment_to_pending_review

Add review comment to the requester's latest pending pull request review.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `path` (string, required): Relative path to the file
- `body` (string, required): Review comment text
- `subjectType` (string, required): "FILE" or "LINE"
- `line` (number, optional): Line number for line comments
- `side` (string, optional): "LEFT" or "RIGHT"
- `startLine` (number, optional): Start line for multi-line comments
- `startSide` (string, optional): Starting side for multi-line comments

**Example Response:**
```json
{
  "id": 567890,
  "path": "src/file.js",
  "line": 10,
  "body": "Consider adding error handling here",
  "user": {
    "login": "reviewer"
  }
}
```

### mcp_github_add_reply_to_pull_request_comment

Add a reply to an existing pull request comment.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number
- `commentId` (number, required): ID of comment to reply to
- `body` (string, required): Reply text

**Example Response:**
```json
{
  "id": 678901,
  "body": "Thanks for the feedback!",
  "in_reply_to_id": 567890,
  "user": {
    "login": "author"
  }
}
```

---

## Release & Tag Management

### mcp_github_list_releases

List releases in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
[
  {
    "id": 789012,
    "tag_name": "v1.0.0",
    "name": "Release 1.0.0",
    "body": "Release notes",
    "draft": false,
    "prerelease": false,
    "created_at": "2023-01-01T00:00:00Z",
    "published_at": "2023-01-01T00:00:00Z"
  }
]
```

### mcp_github_get_latest_release

Get the latest release in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name

**Example Response:**
```json
{
  "id": 789012,
  "tag_name": "v1.0.0",
  "name": "Latest Release",
  "body": "Release notes for latest version",
  "assets": [
    {
      "name": "release.zip",
      "download_count": 100,
      "browser_download_url": "https://github.com/owner/repo/releases/download/v1.0.0/release.zip"
    }
  ]
}
```

### mcp_github_get_release_by_tag

Get a specific release by its tag name.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `tag` (string, required): Tag name (e.g., 'v1.0.0')

**Example Response:**
```json
{
  "id": 789012,
  "tag_name": "v1.0.0",
  "name": "Release 1.0.0",
  "body": "Release notes for v1.0.0"
}
```

### mcp_github_list_tags

List git tags in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
[
  {
    "name": "v1.0.0",
    "commit": {
      "sha": "abc123...",
      "url": "https://api.github.com/repos/owner/repo/commits/abc123"
    },
    "zipball_url": "https://github.com/owner/repo/zipball/v1.0.0",
    "tarball_url": "https://github.com/owner/repo/tarball/v1.0.0"
  }
]
```

### mcp_github_get_tag

Get details about a specific git tag in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `tag` (string, required): Tag name

**Example Response:**
```json
{
  "sha": "abc123...",
  "url": "https://api.github.com/repos/owner/repo/git/tags/abc123",
  "tagger": {
    "name": "Tagger Name",
    "email": "tagger@example.com",
    "date": "2023-01-01T00:00:00Z"
  },
  "object": {
    "sha": "def456...",
    "type": "commit"
  },
  "message": "Tag message"
}
```

---

## Search & Discovery

### mcp_github_search_repositories

Find GitHub repositories by name, description, readme, topics, or other metadata.

**Parameters:**
- `query` (string, required): Repository search query
- `sort` (string, optional): "stars", "forks", "help-wanted-issues", "updated"
- `order` (string, optional): "asc" or "desc"
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page
- `minimal_output` (boolean, optional): Return minimal info (default: true)

**Example Response:**
```json
{
  "total_count": 1000,
  "items": [
    {
      "id": 123456,
      "name": "awesome-project",
      "full_name": "owner/awesome-project",
      "description": "An awesome project",
      "html_url": "https://github.com/owner/awesome-project",
      "stargazers_count": 500,
      "language": "JavaScript"
    }
  ]
}
```

### mcp_github_search_code

Fast and precise code search across ALL GitHub repositories.

**Parameters:**
- `query` (string, required): Search query using GitHub's code search syntax
- `sort` (string, optional): Sort field ('indexed' only)
- `order` (string, optional): "asc" or "desc"
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
{
  "total_count": 200,
  "items": [
    {
      "name": "example.js",
      "path": "src/example.js",
      "sha": "abc123...",
      "html_url": "https://github.com/owner/repo/blob/main/src/example.js",
      "repository": {
        "full_name": "owner/repo"
      },
      "text_matches": [
        {
          "fragment": "function example() {...}"
        }
      ]
    }
  ]
}
```

### mcp_github_search_users

Find GitHub users by username, real name, or other profile information.

**Parameters:**
- `query` (string, required): User search query
- `sort` (string, optional): "followers", "repositories", "joined"
- `order` (string, optional): "asc" or "desc"
- `page` (number, optional): Page number for pagination
- `perPage` (number, optional): Results per page

**Example Response:**
```json
{
  "total_count": 50,
  "items": [
    {
      "login": "username",
      "id": 12345,
      "type": "User",
      "html_url": "https://github.com/username",
      "followers": 100,
      "public_repos": 42
    }
  ]
}
```

### mcp_github_get_team_members

Get member usernames of a specific team in an organization.

**Parameters:**
- `org` (string, required): Organization login
- `team_slug` (string, required): Team slug

**Example Response:**
```json
[
  {
    "login": "team-member-1",
    "id": 12345,
    "type": "User"
  },
  {
    "login": "team-member-2", 
    "id": 23456,
    "type": "User"
  }
]
```

### mcp_github_get_teams

Get details of the teams the user is a member of.

**Parameters:**
- `user` (string, optional): Username to get teams for (defaults to authenticated user)

**Example Response:**
```json
[
  {
    "id": 123456,
    "name": "Development Team",
    "slug": "development",
    "description": "Core development team",
    "organization": {
      "login": "my-org"
    }
  }
]
```

### mcp_github_get_label

Get a specific label from a repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `name` (string, required): Label name

**Example Response:**
```json
{
  "id": 789012,
  "name": "bug",
  "color": "d73a4a",
  "description": "Something isn't working",
  "default": true
}
```

---

## Copilot Integration

### mcp_github_create_pull_request_with_copilot

Delegate a task to GitHub Copilot coding agent to perform in the background.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `problem_statement` (string, required): Detailed description of the task
- `title` (string, required): Title for the pull request
- `base_ref` (string, optional): Git reference to start work from

**Example Response:**
```json
{
  "job_id": "copilot-job-123",
  "status": "in_progress",
  "message": "Copilot agent has started working on your task"
}
```

### mcp_github_assign_copilot_to_issue

Assign Copilot to a specific issue in a GitHub repository.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `issue_number` (number, required): Issue number
- `base_ref` (string, optional): Git reference to start work from
- `custom_instructions` (string, optional): Additional guidance for the agent

**Example Response:**
```json
{
  "assignment_id": "assignment-456",
  "status": "assigned",
  "message": "Copilot has been assigned to issue #42"
}
```

### mcp_github_get_copilot_job_status

Get the status of a GitHub Copilot coding agent job.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `id` (string, required): Job ID or pull request number

**Example Response:**
```json
{
  "id": "copilot-job-123",
  "status": "completed",
  "pull_request": {
    "number": 15,
    "url": "https://github.com/owner/repo/pull/15"
  },
  "created_at": "2023-01-01T00:00:00Z",
  "completed_at": "2023-01-01T00:30:00Z"
}
```

### mcp_github_request_copilot_review

Request a GitHub Copilot code review for a pull request.

**Parameters:**
- `owner` (string, required): Repository owner
- `repo` (string, required): Repository name
- `pullNumber` (number, required): Pull request number

**Example Response:**
```json
{
  "review_id": "copilot-review-789",
  "status": "requested",
  "message": "Copilot review has been requested for pull request #15"
}
```

---

## Error Handling

All GitHub MCP tools return standardized error responses when operations fail:

```json
{
  "error": {
    "type": "github_api_error",
    "message": "Resource not found",
    "status": 404,
    "documentation_url": "https://docs.github.com/rest/reference/repos#get-a-repository"
  }
}
```

Common error status codes:
- `400`: Bad Request - Invalid parameters
- `401`: Unauthorized - Authentication required
- `403`: Forbidden - Insufficient permissions  
- `404`: Not Found - Resource doesn't exist
- `422`: Unprocessable Entity - Validation failed
- `500`: Internal Server Error - GitHub API issue

---

## Authentication

All GitHub MCP tools require authentication via:
- Personal Access Token (PAT) in `GITHUB_TOKEN` environment variable
- GitHub App installation token
- OAuth token

Required scopes depend on the operations:
- `repo` - Full repository access
- `public_repo` - Public repository access only
- `read:org` - Organization metadata access
- `write:discussion` - Discussion management
- `workflow` - GitHub Actions access

This documentation covers all available GitHub MCP tools and their complete input/output schemas for integration and development purposes.
