{
  description = "repo-homepage-sync — keep each app's GitHub repo homepage in sync with its live deployed URL (in-cluster controller for the volt k3s cluster)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Unlike webhook-gateway (zero prod deps), this controller imports the
        # k8s client + octokit, so it can't just hand raw src/*.ts to bun. CI
        # runs `bun install` + `bun build --compile`-style bundling into
        # ./dist/main.js BEFORE `nix build`, and Nix packages that single
        # bundle. Keeping the bundling in CI (not Nix) avoids vendoring
        # node_modules into the nix store while still producing a hermetic
        # single-file image input. The bundle is plain JS run by the bun
        # runtime; no node_modules ship in the image.
        app = pkgs.runCommand "repo-homepage-sync-app" { } ''
          mkdir -p $out/app
          cp ${./dist/main.js} $out/app/main.js
        '';

        # runAsNonRoot + readOnlyRootFilesystem need a real passwd/group record
        # for UID/GID 1000 (bun resolves $HOME from getpwuid). buildLayeredImage
        # doesn't synthesize these.
        passwd = pkgs.writeText "passwd" ''
          root:x:0:0:root:/root:/bin/sh
          app:x:1000:1000:app:/app:/sbin/nologin
        '';
        group = pkgs.writeText "group" ''
          root:x:0:
          app:x:1000:
        '';
        etc = pkgs.runCommand "repo-homepage-sync-etc" { } ''
          mkdir -p $out/etc
          cp ${passwd} $out/etc/passwd
          cp ${group} $out/etc/group
        '';
      in
      {
        packages.default = self.packages.${system}.image;

        # streamLayeredImage streams the tar on stdout; CI's skopeo copies it to
        # GHCR (mirrors webhook-gateway). cacert + SSL_CERT_FILE so octokit's
        # TLS to api.github.com validates.
        packages.image = pkgs.dockerTools.streamLayeredImage {
          name = "repo-homepage-sync";
          tag = "latest";
          contents = [
            pkgs.bun
            pkgs.cacert
            app
            etc
          ];
          config = {
            User = "1000:1000";
            WorkingDir = "/app";
            # NODE_EXTRA_CA_CERTS (set on the Deployment to the ServiceAccount
            # CA) is appended to this default bundle, so the runtime trusts BOTH
            # api.github.com (public CA, here) and the k3s API server (the
            # cluster's self-signed CA). We deliberately do NOT set
            # SSL_CERT_FILE: it REPLACES the trust store, which would drop the
            # public roots and break the GitHub TLS handshake.
            Env = [
              "NODE_ENV=production"
              "PORT=8080"
              "NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
            ];
            ExposedPorts."8080/tcp" = { };
            Cmd = [
              "${pkgs.bun}/bin/bun"
              "run"
              "main.js"
            ];
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bun ];
        };
      }
    );
}
