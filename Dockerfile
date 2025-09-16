FROM python:3.11

WORKDIR /app
COPY . /app

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

CMD ["python", "-c", "print('✅ Container is running Python full image'); import time; time.sleep(20)"]
