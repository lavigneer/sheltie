{
  description = "Herdr desktop mods: ticket -> worktree -> agent -> PR -> merged";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # Packaging only: the built mods and the rest of the repo under
  # share/sheltie, plus `sheltie-install` (install.sh) and
  # `herdr-demo`. Configuring Herdr is left to whoever uses the package.
  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "sheltie";
          version = "0.1.0";
          src = self;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            share=$out/share/sheltie
            mkdir -p $share $out/bin
            cp -R mods layouts skills demo keys.json config.example.json install.sh $share/
            makeWrapper $share/install.sh $out/bin/sheltie-install \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.jq
                  pkgs.coreutils
                ]
              }
            # herdr-app and hc come from the user's Herdr install.
            makeWrapper $share/demo/herdr-demo $out/bin/herdr-demo \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.jq
                  pkgs.git
                  pkgs.coreutils
                  pkgs.gnused
                  pkgs.gnugrep
                  pkgs.procps
                ]
              }
            runHook postInstall
          '';
          meta = {
            description = "Herdr desktop mods: ticket -> worktree -> agent -> PR -> merged";
            license = nixpkgs.lib.licenses.mit;
            platforms = systems;
          };
        };
      });

      # `nix develop .#e2e -c npm run e2e`: everything the end-to-end tests
      # need, with Herdr from the pinned nixpkgs (flake.lock). CI runs it this
      # way; its weekly run overrides nixpkgs with the newest nixos-unstable.
      devShells = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          e2e = pkgs.mkShellNoCC {
            packages = [
              pkgs.herdr-desktop
              pkgs.herdr-core
              pkgs.nodejs_22
              pkgs.xvfb
              pkgs.xdotool
              pkgs.jq
              pkgs.git
            ];
            # Off NixOS (CI) there's no /run/opengl-driver and no GPU: render
            # with Mesa's software Vulkan driver (lavapipe).
            shellHook = ''
              export VK_DRIVER_FILES=${pkgs.mesa}/share/vulkan/icd.d/lvp_icd.${pkgs.stdenv.hostPlatform.uname.processor}.json
            '';
          };
        }
      );
    };
}
