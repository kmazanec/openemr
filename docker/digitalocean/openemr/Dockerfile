# Production image for the openemr service: thin layer on top of the
# upstream `openemr/openemr:flex` image that adds Alpine packages we
# need for the panel's session-side document viewer.
#
# Right now the only addition is `tiff` — Alpine's libtiff package,
# which ImageMagick links against to provide the TIFF decode delegate.
# Without it, `ext-imagick` is loaded but `Imagick::queryFormats('TIFF')`
# returns an empty array and `readImageBlob` on TIFF bytes throws
# "no decode delegate for this image format `TIFF'". F.4b's PHP-side
# TIFF -> PNG decode in document_view.php depends on this delegate.
#
# Pin the upstream digest in lockstep with the `image:` reference in
# docker-compose.yml — bumping flex requires bumping both. The build
# context is empty (no COPY) so the image rebuild is just one apk
# layer; it's near-free in registry storage and rebuild time.
FROM openemr/openemr:flex@sha256:e4562b0c7d3f222ec8f72122ce00d10ffa93f559c38c00ab12c1355394c35d1c

RUN apk add --no-cache tiff
