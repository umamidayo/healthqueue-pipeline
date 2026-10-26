# Local minikube platform. Driven by scripts/local/up.ps1; state stays on disk
# because the cluster is disposable (`scripts/local/down.ps1` deletes both).
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

  backend "local" {
    path = "terraform.tfstate"
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

  cluster_name         = "local"
  git_repo_url         = var.git_repo_url
  git_revision         = var.git_revision
  argocd_url           = "http://localhost:8080"
  enable_monitoring    = var.enable_monitoring
  create_root_app      = var.create_root_app
  prometheus_retention = "7d"
  high_availability    = false
}
