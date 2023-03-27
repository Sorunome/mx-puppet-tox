#!/bin/sh -e

if [ ! -f "$CONFIG_PATH" ]; then
	echo 'No config found'
	exit 1
fi

args="$*"

if [ ! -f "$REGISTRATION_PATH" ]; then
	echo 'No registration found, generating now'
	args="-r"
fi

if [ ! -d "/data/$SAVES_FOLDER" ]; then
	echo "No saves folder found, creating $SAVES_FOLDER"
	mkdir "/data/$SAVES_FOLDER"
fi


# if no --uid is supplied, prepare files to drop privileges
if [ "$(id -u)" = 0 ]; then
	chown node:node /data
	chown node:node "/data/$SAVES_FOLDER"

	if find ./*.db > /dev/null 2>&1; then
		# make sure sqlite files are writeable
		chown node:node ./*.db
	fi
	if find ./*.log.* > /dev/null 2>&1; then
		# make sure log files are writeable
		chown node:node ./*.log.*
	fi

	gosu='gosu node:node'
else
	gosu=''
fi

# $gosu is used in case we have to drop the privileges
# SC2086: Double quote to prevent globbing and word splitting.
# shellcheck disable=2086
exec $gosu /usr/local/bin/node '/opt/mx-puppet-tox/build/index.js' \
     -c "$CONFIG_PATH" \
     -f "$REGISTRATION_PATH" \
     $args
