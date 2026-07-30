FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir torch==2.2.2 torchaudio==2.2.2 \
        --index-url https://download.pytorch.org/whl/cpu

COPY backend/ ./
COPY --from=frontend-build /app/frontend/build ./static

ENV STATIC_DIR=/app/static
ENV PORT=8000

EXPOSE 8000

CMD uvicorn app:app --host 0.0.0.0 --port ${PORT}
