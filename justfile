# galloper justfile - development automation
# Run 'just' or 'just help' to see available commands

set unstable := true
set positional-arguments := true

# Read version from package.json
version := `node -p "require('./package.json').version"`

# Default recipe: show help
default:
    @just help

# Show available commands
help:
    @echo "galloper v{{version}} - Development Commands"
    @echo ""
    @just --list --unsorted

# Install dependencies
install:
    @echo "Installing dependencies..."
    npm install
    @echo "✓ Dependencies installed"

# Setup: install dependencies and build
setup: install build
    @echo "✓ Setup complete"

# Build TypeScript
build:
    @echo "Building..."
    npm run build
    @echo "✓ Build complete"

# Run tests
test:
    npm test

# Watch mode tests
test-watch:
    npm run test:watch

# Tests with coverage
test-coverage:
    npm run test:coverage

# Run galloper with arguments (e.g., 'just dev single-prompt --prompt "hello"')
dev *ARGS:
    npm run run -- {{ARGS}}

# Symlink galloper globally via npm link
link: build
    @echo "Linking galloper globally..."
    npm link
    @echo "✓ galloper linked ($(which galloper))"

# Remove global galloper symlink
unlink:
    @echo "Unlinking galloper..."
    npm unlink -g galloper
    @echo "✓ galloper unlinked"

# Clean build artifacts and runtime data
clean:
    @echo "Cleaning..."
    rm -rf dist/
    rm -rf galloper-data/
    @echo "✓ Cleaned: dist/ and galloper-data/"

# Show version
version:
    @echo "galloper v{{version}}"

# Bump patch version (0.2.0 -> 0.2.1)
bump-patch:
    @echo "Bumping patch version..."
    npm version patch --no-git-tag-version
    @node -p "require('./package.json').version" > VERSION
    @echo "✓ Version bumped to $(cat VERSION)"
    @echo "⚠ Remember to commit package.json and VERSION"

# Bump minor version (0.2.0 -> 0.3.0)
bump-minor:
    @echo "Bumping minor version..."
    npm version minor --no-git-tag-version
    @node -p "require('./package.json').version" > VERSION
    @echo "✓ Version bumped to $(cat VERSION)"
    @echo "⚠ Remember to commit package.json and VERSION"

# Update from latest source
update:
    @echo "Current version: {{version}}"
    @echo "Pulling latest changes..."
    git pull --ff-only
    @echo "Installing dependencies..."
    npm install
    @echo "Building..."
    npm run build
    @echo "New version: $(node -p 'require(\"./package.json\").version')"
    @echo "✓ Update complete"

# Show project status
status:
    @echo "galloper status:"
    @echo "  Version: {{version}}"
    @echo "  Node: $(node --version)"
    @if [ -d dist ]; then echo "  Built: yes"; else echo "  Built: no"; fi
    @if [ -d galloper-data ]; then echo "  Data dir: yes"; else echo "  Data dir: no"; fi
