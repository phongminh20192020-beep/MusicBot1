# Official Lavalink v4 image. Alpine variant = smaller image, faster Railway builds.
# https://lavalink.dev/getting-started/docker
FROM ghcr.io/lavalink-devs/lavalink:4-alpine

# Lavalink's working directory in this image is already /opt/Lavalink and it
# reads ./application.yml from there on startup.
COPY application.yml /opt/Lavalink/application.yml
# Cookie file for YouTube login — paste your Netscape-format cookies into cookies.txt
COPY cookies.txt /opt/Lavalink/cookies.txt
