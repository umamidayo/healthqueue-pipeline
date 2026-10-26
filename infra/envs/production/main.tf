# Shared staging + production cluster platform.
#
# Cluster provisioning (EKS/GKE/AKS/...) is deliberately out of scope; this
# root module bootstraps an existing conformant cluster. See
# docs/adr/0004-opentofu-for-platform-bootstrap.md.
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Partial configuration: supply bucket/key/region with
  #   tofu init -backend-config=backend.hcl
  # (see backend.hcl.example). use_lockfile enables S3-native state locking.
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }

  # OpenTofu client-side state and plan encryption. State holds the generated
  # Grafana password and the full rendered Helm values; with this block it is
  # unreadable to anyone with bucket access but no passphrase. Prefer a KMS
  # key provider (aws_kms, gcp_kms, openbao) over pbkdf2 once one is available.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_encryption_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

provider "helm" {
  kubernetes = {
    config_path    = pathexpand(var.kubeconfig_path)
    config_context = var.kube_context
  }
}

module "platform" {
  source = "../../modules/platform"

  cluster_name               = "production"
  git_repo_url               = var.git_repo_url
  git_revision               = "main"
  argocd_url                 = var.argocd_url
  enable_monitoring          = true
  prometheus_retention       = "35d"
  high_availability          = true
  github_app_id              = var.github_app_id
  github_app_installation_id = var.github_app_installation_id
}
