/*
 * Provisioning commands on the serial console.
 *
 * These exist only in the development and provisioning build. A release build has no
 * shell at all. Nothing here can read a secret back out of the device.
 *
 *   prov status
 *   prov wifi <ssid-base64> <WPA2_PSK|WPA2_PSK_SHA256|WPA3_SAE> <passphrase-base64>
 *   prov cloud <aws-iot-endpoint> <download-url-prefix>
 *   prov keygen [replace]             create the device key pair, print a CSR
 *   prov load begin
 *   prov load add <base64-chunk>      base64 of a DER certificate, in pieces
 *   prov load commit <ca|cert>
 *   prov reset                        factory reset
 */

#include <errno.h>
#include <string.h>

#include <mbedtls/md.h>
#include <mbedtls/pk.h>
#include <mbedtls/platform_util.h>
#include <mbedtls/x509_csr.h>
#include <psa/crypto.h>
#include <zephyr/kernel.h>
#include <zephyr/net/tls_credentials.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/base64.h>
#include <zephyr/sys/reboot.h>

#include "cloud.h"
#include "identity.h"
#include "factory.h"
#include "net.h"
#include "ota.h"
#include "version.h"

#define LOAD_TEXT_MAX 2400
#define DER_MAX       1800
#define KEY_DER_MAX   160
#define CSR_DER_MAX   512
#define PEM_LINE      64

static char load_text[LOAD_TEXT_MAX + 1];
static size_t load_length;
static bool load_open;

static uint8_t der[DER_MAX];

static int cmd_status(const struct shell *sh, size_t argc, char **argv)
{
	const struct identity_settings *config = identity_settings_get();
	char address[18];

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	shell_print(sh, "thing name     %s", identity_thing_name());
	shell_print(sh, "firmware       %s", fw_version_running_string());
	shell_print(sh, "wifi network   %s, link %s", net_has_credentials() ? "stored" : "missing",
		    net_is_up() ? "up" : "down");
	shell_print(sh, "wifi address   %s",
		    net_mac_address(address, sizeof(address)) == 0 ? address : "unknown");
	shell_print(sh, "endpoint       %s", config ? config->endpoint : "missing");
	shell_print(sh, "download from  %s", config ? config->download_url_prefix : "missing");
	shell_print(sh, "root CA        %s", factory_has_root_ca() ? "stored" : "missing");
	shell_print(sh, "private key    %s", factory_has_private_key() ? "stored" : "missing");
	shell_print(sh, "certificate    %s", factory_has_certificate() ? "stored" : "missing");
	shell_print(sh, "cloud          %s", cloud_is_connected() ? "connected" : "not connected");
	shell_print(sh, "update         %s (last: %s)", ota_state_name(), ota_last_result());
	return 0;
}

static int decode_argument(const char *text, uint8_t *out, size_t out_size, size_t *out_length)
{
	return base64_decode(out, out_size, out_length, (const uint8_t *)text, strlen(text));
}

static int cmd_wifi(const struct shell *sh, size_t argc, char **argv)
{
	static uint8_t ssid[32];
	static uint8_t passphrase[128];
	size_t ssid_length = 0;
	size_t passphrase_length = 0;
	enum net_security security;
	int err;

	ARG_UNUSED(argc);

	if (strcmp(argv[2], "WPA2_PSK") == 0) {
		security = NET_SECURITY_WPA2_PSK;
	} else if (strcmp(argv[2], "WPA2_PSK_SHA256") == 0) {
		security = NET_SECURITY_WPA2_PSK_SHA256;
	} else if (strcmp(argv[2], "WPA3_SAE") == 0) {
		security = NET_SECURITY_WPA3_SAE;
	} else {
		shell_error(sh, "Security must be WPA2_PSK, WPA2_PSK_SHA256 or WPA3_SAE");
		return -EINVAL;
	}

	if (decode_argument(argv[1], ssid, sizeof(ssid), &ssid_length) != 0 ||
	    decode_argument(argv[3], passphrase, sizeof(passphrase), &passphrase_length) != 0) {
		mbedtls_platform_zeroize(passphrase, sizeof(passphrase));
		shell_error(sh, "Network name and passphrase must be base64");
		return -EINVAL;
	}

	err = net_credentials_set((const char *)ssid, ssid_length, security,
				  (const char *)passphrase, passphrase_length);
	mbedtls_platform_zeroize(passphrase, sizeof(passphrase));

	if (err) {
		shell_error(sh, "Network was not stored (%d)", err);
		return err;
	}

	shell_print(sh, "OK network stored");
	(void)net_connect();
	return 0;
}

static int cmd_cloud(const struct shell *sh, size_t argc, char **argv)
{
	int err;

	ARG_UNUSED(argc);

	err = identity_settings_set(argv[1], argv[2]);
	if (err) {
		shell_error(sh, "Settings were not stored (%d)", err);
		return err;
	}

	shell_print(sh, "OK cloud settings stored");
	return 0;
}

static void print_pem(const struct shell *sh, const char *label, const uint8_t *data, size_t length)
{
	static char text[((CSR_DER_MAX + 2) / 3) * 4 + 1];
	size_t text_length = 0;

	if (base64_encode((uint8_t *)text, sizeof(text), &text_length, data, length) != 0) {
		shell_error(sh, "Encoding failed");
		return;
	}

	shell_print(sh, "-----BEGIN %s-----", label);
	for (size_t offset = 0; offset < text_length; offset += PEM_LINE) {
		shell_print(sh, "%.*s", (int)MIN(PEM_LINE, text_length - offset), text + offset);
	}
	shell_print(sh, "-----END %s-----", label);
}

/*
 * Create the device identity on the device. The key pair is generated inside TF-M
 * with its random number generator, the private half goes straight into protected
 * storage, and only a certificate signing request leaves the device.
 */
static int cmd_keygen(const struct shell *sh, size_t argc, char **argv)
{
	static uint8_t key_der[KEY_DER_MAX];
	static uint8_t csr_der[CSR_DER_MAX];
	static char subject[80];
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t key = PSA_KEY_ID_NULL;
	mbedtls_x509write_csr request;
	mbedtls_pk_context pk;
	int key_length;
	int csr_length;
	int err = -EIO;

	if (factory_has_private_key() && !(argc == 2 && strcmp(argv[1], "replace") == 0)) {
		shell_error(sh, "A device key already exists. `prov keygen replace` discards it "
				"and its certificate.");
		return -EEXIST;
	}

	mbedtls_pk_init(&pk);
	mbedtls_x509write_csr_init(&request);

	psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&attributes, 256);
	psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_EXPORT);

	if (psa_generate_key(&attributes, &key) != PSA_SUCCESS) {
		shell_error(sh, "Key generation failed");
		goto out;
	}

	if (mbedtls_pk_copy_from_psa(key, &pk) != 0) {
		shell_error(sh, "Key could not be prepared");
		goto out;
	}

	(void)snprintk(subject, sizeof(subject), "CN=%s", identity_thing_name());
	mbedtls_x509write_csr_set_md_alg(&request, MBEDTLS_MD_SHA256);
	mbedtls_x509write_csr_set_key(&request, &pk);

	if (mbedtls_x509write_csr_set_subject_name(&request, subject) != 0) {
		shell_error(sh, "Request subject could not be set");
		goto out;
	}

	/* Both writers fill their buffer from the end and return the length. */
	csr_length = mbedtls_x509write_csr_der(&request, csr_der, sizeof(csr_der));
	key_length = mbedtls_pk_write_key_der(&pk, key_der, sizeof(key_der));
	if (csr_length <= 0 || key_length <= 0) {
		shell_error(sh, "Request could not be created");
		goto out;
	}

	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY);
	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE);

	err = tls_credential_add(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY,
				 key_der + sizeof(key_der) - key_length, key_length);
	if (err) {
		shell_error(sh, "Private key could not be stored (%d)", err);
		goto out;
	}

	print_pem(sh, "CERTIFICATE REQUEST", csr_der + sizeof(csr_der) - csr_length, csr_length);
	shell_print(sh, "OK key pair created");
	err = 0;

out:
	mbedtls_platform_zeroize(key_der, sizeof(key_der));
	mbedtls_x509write_csr_free(&request);
	mbedtls_pk_free(&pk);
	if (key != PSA_KEY_ID_NULL) {
		(void)psa_destroy_key(key);
	}

	return err;
}

static int cmd_load_begin(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	load_length = 0;
	load_open = true;
	shell_print(sh, "OK");
	return 0;
}

static int cmd_load_add(const struct shell *sh, size_t argc, char **argv)
{
	size_t length = strlen(argv[1]);

	ARG_UNUSED(argc);

	if (!load_open || load_length + length > LOAD_TEXT_MAX) {
		load_open = false;
		shell_error(sh, "Nothing is being loaded, or the data is too long");
		return -ENOSPC;
	}

	memcpy(load_text + load_length, argv[1], length);
	load_length += length;
	shell_print(sh, "OK %u", (unsigned int)load_length);
	return 0;
}

static int store_credential(sec_tag_t tag, enum tls_credential_type type, size_t length)
{
	(void)tls_credential_delete(tag, type);
	return tls_credential_add(tag, type, der, length);
}

static int cmd_load_commit(const struct shell *sh, size_t argc, char **argv)
{
	size_t length = 0;
	int err;

	ARG_UNUSED(argc);

	if (!load_open || load_length == 0) {
		shell_error(sh, "Nothing has been loaded");
		return -ENODATA;
	}

	load_open = false;
	load_text[load_length] = '\0';

	if (base64_decode(der, sizeof(der), &length, (const uint8_t *)load_text, load_length) != 0 ||
	    length < 64 || der[0] != 0x30) {
		shell_error(sh, "The data is not a base64 DER certificate");
		return -EINVAL;
	}

	if (strcmp(argv[1], "ca") == 0) {
		/* The same root signs the AWS IoT endpoint and the download host. */
		err = store_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE, length);
		err = err ? err : store_credential(FACTORY_DOWNLOAD_SEC_TAG,
						   TLS_CREDENTIAL_CA_CERTIFICATE, length);
	} else if (strcmp(argv[1], "cert") == 0) {
		err = store_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE,
				       length);
	} else {
		shell_error(sh, "Commit as `ca` or `cert`");
		return -EINVAL;
	}

	if (err) {
		shell_error(sh, "Certificate could not be stored (%d)", err);
		return err;
	}

	shell_print(sh, "OK %s stored (%u bytes)", argv[1], (unsigned int)length);
	return 0;
}

static int cmd_reset(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	cloud_disconnect();
	factory_reset();
	shell_print(sh, "OK erased, restarting");
	k_msleep(200);
	sys_reboot(SYS_REBOOT_COLD);
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(load_commands,
	SHELL_CMD_ARG(begin, NULL, "Start loading a certificate", cmd_load_begin, 1, 0),
	SHELL_CMD_ARG(add, NULL, "<base64-chunk>", cmd_load_add, 2, 0),
	SHELL_CMD_ARG(commit, NULL, "<ca|cert>", cmd_load_commit, 2, 0),
	SHELL_SUBCMD_SET_END);

SHELL_STATIC_SUBCMD_SET_CREATE(prov_commands,
	SHELL_CMD_ARG(status, NULL, "Show what is provisioned (no secrets)", cmd_status, 1, 0),
	SHELL_CMD_ARG(wifi, NULL, "<ssid-base64> <security> <passphrase-base64>", cmd_wifi, 4, 0),
	SHELL_CMD_ARG(cloud, NULL, "<endpoint> <download-url-prefix>", cmd_cloud, 3, 0),
	SHELL_CMD_ARG(keygen, NULL, "[replace] Create the device key pair and print a CSR",
		      cmd_keygen, 1, 1),
	SHELL_CMD(load, &load_commands, "Load the root CA or the device certificate", NULL),
	SHELL_CMD_ARG(reset, NULL, "Factory reset", cmd_reset, 1, 0),
	SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(prov, &prov_commands, "Device provisioning", NULL);
