/*
 * The device's key pair and certificates, for the console's KEYGEN and STREAM commands.
 * Nothing here can read a secret back out of the device.
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
#include <zephyr/sys/base64.h>

#include "console_cmd.h"
#include "console_port.h"
#include "factory.h"
#include "identity.h"

#define KEY_DER_MAX 160
#define CSR_DER_MAX 512
#define PEM_LINE    64

static int print_pem(const char *label, const uint8_t *data, size_t length)
{
	static char text[((CSR_DER_MAX + 2) / 3) * 4 + 1];
	size_t text_length = 0;
	int err = base64_encode((uint8_t *)text, sizeof(text), &text_length, data, length);

	if (err) {
		return err;
	}

	console_reply_line("-----BEGIN %s-----", label);
	for (size_t offset = 0; offset < text_length; offset += PEM_LINE) {
		console_reply_line("%.*s", (int)MIN(PEM_LINE, text_length - offset), text + offset);
	}
	console_reply_line("-----END %s-----", label);
	return 0;
}

/* Between console_port_keygen_create() and console_port_keygen_end(). */
static uint8_t key_der[KEY_DER_MAX];
static uint8_t csr_der[CSR_DER_MAX];
static int key_length;
static int csr_length;

/*
 * Create the device identity on the device. The key pair is generated inside TF-M
 * with its random number generator, and only a certificate signing request leaves
 * the device. It does not stay inside TF-M, though. The private half is exported into
 * this application's memory to make the request and to go into protected storage; those
 * copies are wiped afterwards (console_port_keygen_end() and mbedtls_pk_free()). After
 * that the TLS stack reads it back from protected storage into this application's heap
 * for every connection to the cloud, and the code that frees that buffer does not wipe it.
 */
int console_port_keygen_create(const char **reason)
{
	static char subject[80];
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t key = PSA_KEY_ID_NULL;
	mbedtls_x509write_csr request;
	mbedtls_pk_context pk;
	int err = -EIO;

	mbedtls_pk_init(&pk);
	mbedtls_x509write_csr_init(&request);

	psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&attributes, 256);
	psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_EXPORT);

	if (psa_generate_key(&attributes, &key) != PSA_SUCCESS) {
		*reason = "key generation failed";
		goto out;
	}

	if (mbedtls_pk_copy_from_psa(key, &pk) != 0) {
		*reason = "key could not be prepared";
		goto out;
	}

	(void)snprintk(subject, sizeof(subject), "CN=%s", identity_thing_name());
	mbedtls_x509write_csr_set_md_alg(&request, MBEDTLS_MD_SHA256);
	mbedtls_x509write_csr_set_key(&request, &pk);

	if (mbedtls_x509write_csr_set_subject_name(&request, subject) != 0) {
		*reason = "request subject could not be set";
		goto out;
	}

	/* Both writers fill their buffer from the end and return the length. */
	csr_length = mbedtls_x509write_csr_der(&request, csr_der, sizeof(csr_der));
	key_length = mbedtls_pk_write_key_der(&pk, key_der, sizeof(key_der));
	if (csr_length <= 0 || key_length <= 0) {
		*reason = "request could not be created";
		goto out;
	}

	err = 0;

out:
	mbedtls_x509write_csr_free(&request);
	mbedtls_pk_free(&pk);
	if (key != PSA_KEY_ID_NULL) {
		(void)psa_destroy_key(key);
	}

	return err;
}

int console_port_keygen_store(void)
{
	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY);
	(void)tls_credential_delete(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE);

	return tls_credential_add(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY,
				  key_der + sizeof(key_der) - key_length, key_length);
}

int console_port_keygen_print(void)
{
	return print_pem("CERTIFICATE REQUEST", csr_der + sizeof(csr_der) - csr_length, csr_length);
}

void console_port_keygen_end(void)
{
	mbedtls_platform_zeroize(key_der, sizeof(key_der));
}

static int store_credential(sec_tag_t tag, enum tls_credential_type type, const uint8_t *der,
			    size_t length)
{
	(void)tls_credential_delete(tag, type);
	return tls_credential_add(tag, type, der, length);
}

int console_port_store_certificate(enum console_stream_kind kind, const uint8_t *der, size_t length)
{
	int err;

	if (kind == CONSOLE_STREAM_CERT) {
		return store_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE, der,
					length);
	}

	/* The same root signs the AWS IoT endpoint and the download host. */
	err = store_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE, der, length);
	return err ? err
		   : store_credential(FACTORY_DOWNLOAD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE, der,
				      length);
}
