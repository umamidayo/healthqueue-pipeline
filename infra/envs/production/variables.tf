variable "state_encryption_passphrase" {
  description = "Passphrase for OpenTofu state/plan encryption (>= 16 chars). Supply via TF_VAR_state_encryption_passphrase from a secret store."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.state_encryption_passphrase) >= 16
    error_message = "state_encryption_passphrase must be at least 16 characters."
  }
}

variable "kubeconfig_path" {
  description = "Path to a kubeconfig with cluster-admin on the target cluster."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "kubeconfig context of the target cluster."
  type        = string
}

variable "git_repo_url" {
  description = "Repository Argo CD syncs from."
  type        = string
  default     = "https://github.com/umamidayo/healthqueue-pipeline.git"
}

variable "argocd_url" {
  description = "Public URL of the Argo CD UI."
  type        = string
}

variable "github_app_id" {
  description = "Optional. GitHub App used by Argo CD Notifications to write GitHub Deployments. Empty (default) disables the notifier; DORA then uses promotion commits (ADR 0013)."
  type        = string
  default     = ""
}

variable "github_app_installation_id" {
  description = "Optional. Installation ID of that GitHub App."
  type        = string
  default     = ""
}
