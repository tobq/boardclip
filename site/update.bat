@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://clippy-sh.netlify.app/update.ps1 | iex"
