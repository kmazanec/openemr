# Production image for the openemr service: thin layer on top of the
# upstream `openemr/openemr:flex` image that adds Alpine packages we
# need for the panel's session-side document viewer.
#
# Right now the only addition is `imagemagick-tiff` — Alpine splits
# ImageMagick's format support across subpackages, and TIFF is one
# of them. Installing it registers the libtiff delegate so
# `Imagick::queryFormats('TIFF')` reports support and
# `readImageBlob` accepts TIFF bytes. Without it, `ext-imagick` loads
# but throws "no decode delegate for this image format `TIFF'" on
# TIFF inputs. F.4b's PHP-side TIFF -> PNG decode in
# document_view.php depends on this delegate.
#
# Note: installing the `tiff` package alone (libtiff) is not enough.
# The flex image's ImageMagick is compiled without TIFF support, so
# adding only the runtime library doesn't backfill the delegate; the
# `imagemagick-tiff` Alpine subpackage is what actually wires libtiff
# into ImageMagick at the package-manager level.
#
# Pin the upstream digest in lockstep with the `image:` reference in
# docker-compose.yml — bumping flex requires bumping both. The build
# context is empty (no COPY) so the image rebuild is just one apk
# layer; it's near-free in registry storage and rebuild time.
FROM openemr/openemr:flex@sha256:e4562b0c7d3f222ec8f72122ce00d10ffa93f559c38c00ab12c1355394c35d1c

RUN apk add --no-cache imagemagick-tiff
