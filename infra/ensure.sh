#!/usr/bin/env bash
# Idempotent: creates whatever is missing, starts a stopped VM, soft-reboots an unhealthy one.
# Run by .github/workflows/watchdog.yml. Needs the oci CLI already configured, plus jq and curl.
set -euo pipefail
# Say which command failed (GitHub masks any secret in it): a bare exit code is undebuggable.
trap 'echo "ensure.sh failed (exit $?) at line $LINENO: $BASH_COMMAND"' ERR
cd "$(dirname "$0")"

NAME=chaat-mix
C=$OCI_COMPARTMENT_OCID
SHAPE=${SHAPE:-VM.Standard.E2.1.Micro}
GRACE_MIN=25 # first boot installs and builds everything; don't judge health before this
APP_VARS=(PUBLIC_URL ACCESS_SECRET YOUTUBE_API_KEY YOUTUBE_CHANNEL_ID GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
	TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET DUCKDNS_SUBDOMAIN DUCKDNS_TOKEN STATE_PAR_URL REPO_URL)

# First id from a list call, or empty.
first() { oci "$@" --query 'data[0].id' --raw-output 2>/dev/null || true; }

# ---- Network: VCN, internet gateway, open 80/443 only, one public subnet ----
VCN=$(first network vcn list -c "$C" --display-name "$NAME")
[ -n "$VCN" ] || VCN=$(oci network vcn create -c "$C" --display-name "$NAME" --cidr-block 10.0.0.0/16 \
	--wait-for-state AVAILABLE --query 'data.id' --raw-output)

IGW=$(first network internet-gateway list -c "$C" --vcn-id "$VCN")
[ -n "$IGW" ] || IGW=$(oci network internet-gateway create -c "$C" --vcn-id "$VCN" --display-name "$NAME" \
	--is-enabled true --wait-for-state AVAILABLE --query 'data.id' --raw-output)

read -r RT SL < <(oci network vcn get --vcn-id "$VCN" \
	--query 'data.["default-route-table-id","default-security-list-id"] | join(`" "`, @)' --raw-output)
oci network route-table update --rt-id "$RT" --force \
	--route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" > /dev/null
# Replaces Oracle's default rules, which also open SSH: only web traffic gets in.
oci network security-list update --security-list-id "$SL" --force \
	--ingress-security-rules '[{"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
		{"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}}]' \
	--egress-security-rules '[{"protocol":"all","destination":"0.0.0.0/0"}]' > /dev/null

SUBNET=$(first network subnet list -c "$C" --vcn-id "$VCN")
[ -n "$SUBNET" ] || SUBNET=$(oci network subnet create -c "$C" --vcn-id "$VCN" --display-name "$NAME" \
	--cidr-block 10.0.0.0/24 --wait-for-state AVAILABLE --query 'data.id' --raw-output)

# ---- Instance ----
instance() {
	oci compute instance list -c "$C" --display-name "$NAME" \
		--query "data[?\"lifecycle-state\"!='TERMINATED'] | [0]" 2>/dev/null || true
}
INST=$(instance)

if [ "${RECREATE:-false}" = true ] && [ -n "$INST" ]; then
	echo "Recreating: terminating the current VM."
	oci compute instance terminate --instance-id "$(jq -r .id <<< "$INST")" --force
	for _ in $(seq 1 40); do [ -z "$(instance)" ] && break; sleep 15; done # wait up to 10 min for it to be gone
	INST=""
fi

if [ -z "$INST" ]; then
	echo "No VM: launching one."
	for v in "${APP_VARS[@]}"; do [ -n "${!v:-}" ] || { echo "Missing secret: $v"; exit 1; }; done
	{
		echo '#!/bin/bash'
		echo "cat > /etc/chaat-mix.env <<'ENV'"
		for v in "${APP_VARS[@]}"; do printf "%s='%s'\n" "$v" "${!v}"; done
		echo 'ENV'
		cat boot.sh
	} > /tmp/user-data.sh
	IMAGE=$(first compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
		--shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC)
	# The free AMD shape exists in only one availability domain, and capacity comes and goes: try each.
	for AD in $(oci iam availability-domain list -c "$C" --query 'data[].name' --raw-output | jq -r '.[]'); do
		if oci compute instance launch -c "$C" --availability-domain "$AD" --shape "$SHAPE" --display-name "$NAME" \
			--image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true --user-data-file /tmp/user-data.sh \
			--availability-config '{"recoveryAction":"RESTORE_INSTANCE"}' --wait-for-state RUNNING > /dev/null; then
			echo "Launched in $AD. First boot takes ~${GRACE_MIN} minutes."
			rm -f /tmp/user-data.sh
			exit 0
		fi
	done
	rm -f /tmp/user-data.sh
	echo "Could not launch in any availability domain (often: free capacity is full). The next run retries."
	exit 1
fi

ID=$(jq -r .id <<< "$INST")
STATE=$(jq -r '."lifecycle-state"' <<< "$INST")
echo "VM is $STATE."
case "$STATE" in
STOPPED)
	echo "Starting it (Oracle stops idle free VMs)."
	oci compute instance action --instance-id "$ID" --action START > /dev/null
	exit 0 ;;
RUNNING) ;;
*) exit 0 ;; # starting, stopping or provisioning: check again next run
esac

CREATED=$(date -d "$(jq -r '."time-created"' <<< "$INST")" +%s)
if [ $(( ($(date +%s) - CREATED) / 60 )) -lt "$GRACE_MIN" ]; then echo "Still in first-boot grace period."; exit 0; fi

if ! HEALTH=$(curl -fsS --max-time 20 "$PUBLIC_URL/health"); then
	echo "App unreachable: soft-rebooting the VM (keeps disk and certificates)."
	oci compute instance action --instance-id "$ID" --action SOFTRESET > /dev/null
	exit 1
fi
echo "$HEALTH"
if [ "$(jq -r .ok <<< "$HEALTH")" != true ]; then
	echo "A source needs attention (see above): the streamer gets the in-app popup; this failure emails you."
	exit 1
fi
