<!-- harn:assume vscode-copilot-bridge-is-manual-local-and-credential-private ref=vscode-copilot-manual-install-doc -->
# Codor Copilot Bridge

This companion lets Codor use the **native GitHub Copilot agent inside VS Code**.
VS Code and the official GitHub Copilot Chat extension continue to own sign-in,
context collection, model execution, tool execution, and edits. Native tool
Allow actions are handled inside each chat that Codor creates; no global VS Code
approval setting is changed.

## Install manually

1. Verify Copilot Chat works normally in the target VS Code or WSL window.
2. Install this extension from its Marketplace page, or build the VSIX with
   `pnpm --filter @codor/adapter-copilot vscode:package` and choose
   **Extensions: Install from VSIX…** in that window.
3. Reload the window. Run **Codor: Show Copilot Bridge Status** to confirm it is
   listening.
4. In Codor, refresh the agent list and select **VS Code Copilot**.

The extension must be installed in the workspace extension host. In WSL or
another remote workspace, install it on that remote side.

The pinned VS Code command surface does not expose a `sessionResource`, so
export and native Allow operate on the active/focused chat. Keep the
Codor-created chat focused while a turn runs; the bridge verifies its exact
prompt and exported request id before each action and fails closed if focus
changes.

Codor never installs, updates, or publishes this extension automatically. The
bridge listens only on `127.0.0.1`, uses a random local bearer token, and never
reads or exports GitHub/VS Code credentials.
<!-- harn:end vscode-copilot-bridge-is-manual-local-and-credential-private -->
