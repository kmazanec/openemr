# Thin overlay on the upstream openemr/openemr:flex image, adding the
# Apache configuration Railway requires.
#
# Why this exists:
#   Railway's edge proxy speaks plain HTTP to upstream containers and
#   does not validate self-signed TLS certs (because it doesn't speak
#   TLS to the upstream at all). The upstream flex image's Apache only
#   serves the OpenEMR application via the :443 vhost (with a self-
#   signed cert), so the edge → container hop fails with 502.
#
#   This image adds an Apache drop-in config that:
#     - Enables mod_remoteip so the real client IP is logged.
#     - Trusts Railway's edge address ranges as proxies.
#     - Tells Apache to honor X-Forwarded-Proto: https so OpenEMR
#       generates https:// URLs and sets Secure cookies.
#
#   No application code is modified. No upstream behavior is changed
#   except via Apache's drop-in config dir (/etc/apache2/conf.d/),
#   which the upstream image already reads on startup.
#
# Build:
#   docker build -t kmazanec/openemr-railway:flex docker/railway/
#   docker push kmazanec/openemr-railway:flex

FROM openemr/openemr:flex@sha256:e4562b0c7d3f222ec8f72122ce00d10ffa93f559c38c00ab12c1355394c35d1c

# Drop the Railway-specific Apache config into the conf.d directory.
# The "zz-" prefix ensures it loads alphabetically after upstream's
# own configs, so any directives we set here override theirs.
COPY zz-railway.conf /etc/apache2/conf.d/zz-railway.conf
