# Use a stable full Python image for maximum compatibility
FROM python:3.11

# Prevent Python from writing .pyc files and buffer stdout (for instant Railway logs)
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Set working directory
WORKDIR /app

# Ensure directory has correct permissions
RUN mkdir -p /app && chown -R 1000:1000 /app

# Copy dependency list first (for better Docker caching)
COPY requirements.txt /app/

# Install dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy the rest of the project files
COPY main.py /app/

# Run the bot
CMD ["python", "main.py"]
