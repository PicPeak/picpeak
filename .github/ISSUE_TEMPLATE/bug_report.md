---
name: Bug report
about: Create a report to help us improve PicPeak
title: '[BUG] '
labels: 'bug'
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.

**Environment (please complete the following information):**
 - OS and version:
 - Browser and version:
 - PicPeak version and Docker image tag (if applicable):
 - Deployment method: [Docker Compose, all-in-one container, manual]
 - Database and version: [PostgreSQL, SQLite]

**Logs**
Please include relevant logs:
```
# Backend logs (Docker Compose)
docker compose logs --tail=50 backend

# Or all-in-one container logs (replace picpeak if your container has another name)
docker logs --tail=50 picpeak

# Frontend console errors
[paste any browser console errors]
```

**Additional context**
Add any other context about the problem here.

**Possible Solution**
If you have an idea how to fix the issue, please describe it here.
