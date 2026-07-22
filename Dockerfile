# ==========================================
# STAGE 1: The Build Environment (Builder)
# ==========================================
FROM node:20-slim AS builder
WORKDIR /app

# Copy package configuration files first to leverage build caching
COPY package*.json ./

# Install ALL dependencies (including devDependencies if needed later)
RUN npm ci

# Copy the rest of your backend source code
COPY . .

# Delete development tools or unnecessary files before passing to production stage
RUN npm prune --production


# ==========================================
# STAGE 2: The Lean Production Runner
# ==========================================
FROM node:20-slim
WORKDIR /app

# Copy ONLY the runtime application and cleaned node_modules from the builder stage
COPY --from=builder /app /app

# Open the port your ZHINI Hono app is listening on (Port 3003)
EXPOSE 3003

# The command to start your backend server
CMD ["node", "index.js"]