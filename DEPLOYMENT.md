# Deployment Guide: Node.js Application

## Prerequisites

- Node.js and npm installed on the server
- Access to the project source code

## Deployment Steps

1. **Prepare Application Files**
   - For production, only include:
     - `dist/prod/` (output of `npm run build:prod`)
     - `package.json`
     - `package-lock.json`
     - Application entry point (e.g., `index.js` if not bundled)
   - Exclude:
     - `node_modules/` (reinstall on server)
     - Source files (e.g., `src/`, `test/`, `docs/`, etc.)
     - Dev tools, configs, and large assets not required at runtime
     - `.git/`, `memory-bank/`, `.vscode/`, and any test files (e.g., files ending with `.test.js` or in a `/test` directory)

2. **Install Production Dependencies**
   - On the server, run:
     ```bash
     npm install --production
     ```

3. **Configure Environment Variables**
   - Create a `.env` file in the project root.
   - Add all required environment variables in `KEY=VALUE` format.
   - *Example:*
     ```
     PORT=3000
     DATABASE_URL=mongodb://localhost:27017/mydb
     ```

4. **Start the Application**
   - Use one of the following methods:
     - Directly:
       ```bash
       node index.js
       ```
     - With a process manager for reliability (recommended):
       ```bash
       pm2 start index.js --name cohere-proxy
       ```

5. **(Optional) Bundle as Standalone Executable**
   - If needed, use a tool like `pkg` or `nexe` to create a standalone binary.
   - For most webservers, deploying as a standard Node.js app is sufficient.

## Edge Cases

- If environment variables are missing, the application may fail to start or behave unexpectedly. Always check `.env` completeness.
- If dependency installation fails, verify Node.js and npm versions, and check for permission issues.
- Do not commit sensitive files (e.g., `.env`) to version control.

## Next Steps

1. Review the guide for completeness and clarity.
2. Add it to your project’s deployment documentation.
3. Test the deployment process on a staging server to validate instructions.