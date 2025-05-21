# Certificate as of 2025-02-22

When api.iternio.com changes CDN provider or reverse proxy configuration we need to import new trusted root CA in OVMS.

For some reason certificates switch once in a while between Cloudflare certificates and GoDaddy certificates.

## GoDaddy


Chain of trust https://certs.godaddy.com/repository

Source for gdroot-g2.crt file : https://certs.godaddy.com/repository/gdroot-g2.crt

## Cloudflare

`api.iternio.com` is currently behind Cloudflare.

List of Cloudflare issuing authorities: https://developers.cloudflare.com/ssl/reference/certificate-authorities

Currently the Cloudflare certificates can be issued either by Let's Encrypt or Google Trust Services

### Let's Encrypt

**This certificate is included by default in OVMS. You should see it when running `tls trust list` in OVMS.**

Chain of trust https://letsencrypt.org/certificates/

Source for isrgrootx1.pem file : https://letsencrypt.org/certs/isrg-root-x1-cross-signed.pem

### Google Trust Services



Chain of trust https://pki.goog/repository/

Since all Google root CA are cross-signed by GlobalSign it makes more sense to import the GlobalSign certificate.

Source for root-r1.crt file : http://secure.globalsign.com/cacert/root-r1.crt

https://valid.r1.roots.globalsign.com/


# Changelog

* 2025-02-22: GoDaddy
* 2024-11-20: Cloudflare
* 2024-02-06: GoDaddy
* 2024-04-27: Google Ca
* 2023-01-02: Baltimore CyberTrust

