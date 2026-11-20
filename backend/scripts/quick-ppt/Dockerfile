FROM python:3.12-slim-bookworm

ENV LANG=C.UTF-8 PYTHONUNBUFFERED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-impress poppler-utils fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-lock.txt requirements-ppt-lock.txt /opt/ppt-locks/
RUN awk '/^[a-z]/ { keep = /^(annotated-types|lxml|pillow|pydantic|pydantic-core|typing-extensions|typing-inspection)==/ } keep && !/^#/ { print }' \
      /opt/ppt-locks/requirements-lock.txt > /opt/ppt-locks/runner.txt \
    && grep -E '^(python_pptx|xlsxwriter)==' /opt/ppt-locks/requirements-ppt-lock.txt >> /opt/ppt-locks/runner.txt \
    && python -m pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps -r /opt/ppt-locks/runner.txt \
    && python -m pip check

COPY app/presentations/quick_plan.py app/presentations/quick_renderer.py /opt/quick-ppt/app/presentations/
COPY scripts/quick-ppt/run.py /opt/quick-ppt/run.py
WORKDIR /workspace
USER 65532:65532
