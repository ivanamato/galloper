#!/bin/bash
# Mock command that mixes valid JSON and garbage
echo '{"valid":"json"}'
echo "This is not JSON at all!"
echo '{"another":"valid"}'
echo "garbage line"
echo '{"final":true}'
