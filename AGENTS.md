# Codex Working Rule

After completing any task in this repository:

1. Check whether project files changed with `git status --short`.
2. If files changed, run `git add -A`, commit the changes with a concise message, and push to `origin main`.
3. Report the commit hash and push result to the user.
4. If no files changed, report that there was nothing to update.
5. Never overwrite remote changes. If the local branch is behind `origin/main`, stop and report the issue before committing or pushing.
