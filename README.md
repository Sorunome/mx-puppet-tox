[Support Chat](https://matrix.to/#/#mx-puppet-bridge:sorunome.de) [![donate](https://liberapay.com/assets/widgets/donate.svg)](https://liberapay.com/Sorunome/donate)

# mx-puppet-tox
This is a tox puppeting bridge for matrix. It basically acts like a tox client for matrix. It is based on [mx-puppet-bridge](https://github.com/Sorunome/mx-puppet-bridge).

## Setup

You need at least node 12 to be able to run this!

Clone the repo and install the dependencies:

```
git clone https://github.com/Sorunome/mx-puppet-tox
cd mx-puppet-tox
npm install
```

Copy and edit the configuration file to your liking:

```
cp sample.config.yaml config.yaml
... edit config.yaml ...
```

Generate an appservice registration file. Optional parameters are shown in
brackets with default values:

```
npm run start -- -r [-c config.yaml] [-f tox-registration.yaml]
```

Then add the path to the registration file to your synapse `homeserver.yaml`
under `app_service_config_files`, and restart synapse.

Finally, run the bridge:

```
npm run start
```

### Docker

If you prefer to use a docker based setup an image is available at ghcr.io/sorunome/mx-puppet-tox:master

docker-compose:
```
mx-puppet-tox:
    container_name: mx-puppet-tox
    image: ghcr.io/sorunome/mx-puppet-tox:master
    restart: unless-stopped
    volumes:
      - ./mx-puppet-tox:/data
    environment:
      - SAVES_FOLDER=toxsaves
      - USE_TIMESTAMP=false
```

## Linking

Start a chat with `@_toxpuppet_bot:yourserver.com`

```
link <username>
```

This creates a new Tox identity.

If you wish to use your existing one, export it from your Tox client and overwrite the link you just created and restart the bridge.

All available commands can be viewed with `help` command.


