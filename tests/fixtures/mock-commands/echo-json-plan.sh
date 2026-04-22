#!/bin/bash
# Mock command that emits valid plan JSON
cat <<'EOF'
{
  "planId": "mock-plan-1",
  "tasks": [
    {
      "id": "t1",
      "title": "First task",
      "files": [{"path": "/path/to/file.ts", "action": "edit"}],
      "instructions": "Do something",
      "verify": "echo ok",
      "dependsOn": []
    }
  ]
}
EOF
