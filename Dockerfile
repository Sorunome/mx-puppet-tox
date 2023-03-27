FROM node:12-bullseye AS builder

WORKDIR /opt/mx-puppet-tox

# run build process as user in case of npm pre hooks
# pre hooks are not executed while running as root
RUN chown node:node /opt/mx-puppet-tox
USER node

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


FROM node:12-bullseye

VOLUME /data

ENV CONFIG_PATH=/data/config.yaml \
    REGISTRATION_PATH=/data/tox-registration.yaml

# gosu is used by docker-run.sh to drop privileges
RUN  set -ex; \
     sed -i s/bullseye/bookworm/g /etc/apt/sources.list; \
     apt-get update; \
     apt-get install -y --no-install-recommends libtoxcore2 libtoxcore-dev gosu; \
     apt-get purge -y --auto-remove; \
     rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mx-puppet-tox
COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-tox/node_modules/ ./node_modules/
COPY --from=builder /opt/mx-puppet-tox/build/ ./build/

# change workdir to /data so relative paths in the config.yaml
# point to the persisten volume
WORKDIR /data
ENTRYPOINT ["/opt/mx-puppet-tox/docker-run.sh"]
