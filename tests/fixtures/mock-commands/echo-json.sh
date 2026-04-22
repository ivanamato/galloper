#!/bin/bash
# Mock command that emits JSON events
echo '{"type":"event","data":"first"}'
echo '{"type":"message","text":"processing"}'
echo '{"type":"final","output":"Test output completed"}'
