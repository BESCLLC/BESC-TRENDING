# Use an official Node.js LTS image (stable for production)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install dependencies (no cache for smaller image)
RUN npm install --omit=dev

# Copy the rest of your code
COPY . .

# Expose port if you run a health server (optional)
EXPOSE 3000

# Run the bot
CMD ["node", "main.js"]
