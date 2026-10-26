variable "cluster_name" {
  description = "Selects the Argo CD app-of-apps entry point: argocd/clusters/<cluster_name>."
  type        = string

  validation {
    condition     = contains(["local", "production"], var.cluster_name)
    error_message = "cluster_name must be \"local\" or \"production\" (a directory under argocd/clusters/)."
  }
}

variable "git_repo_url" {
  description = "HTTPS URL of the GitOps repository Argo CD syncs from."
  type        = string
  default     = "https://github.com/umamidayo/healthqueue-pipeline.git"
}

variable "git_revision" {
  description = "Branch, tag or commit Argo CD tracks. Override to test a feature branch locally."
  type        = string
  default     = "main"
}

variable "create_root_app" {
  description = "Create the root Application that hands the cluster to Argo CD. Disabled by scripts/local/up.ps1 -Mode Direct, which applies manifests from the working tree instead."
  type        = bool
  default     = true
}

variable "argocd_url" {
  description = "External URL of the Argo CD UI; used in links posted to GitHub Deployments."
  type        = string
  default     = "http://localhost:8080"
}

variable "enable_monitoring" {
  description = "Install kube-prometheus-stack (Prometheus Operator, Prometheus, Alertmanager, Grafana)."
  type        = bool
  default     = true
}

variable "prometheus_retention" {
  description = "Prometheus TSDB retention. Must cover the 30d SLO window wherever SLOs are reported."
  type        = string
  default     = "35d"
}

variable "high_availability" {
  description = "Run multiple replicas of Argo CD and Kyverno controllers."
  type        = bool
  default     = false
}

variable "github_app_id" {
  description = <<-EOT
    GitHub App ID used by Argo CD Notifications to write GitHub Deployments
    (the DORA data source). Empty disables the GitHub notifier. The app's
    private key must be stored in the argocd-notifications-secret Secret under
    the key "github-privateKey" (see docs/operations.md).
  EOT
  type        = string
  default     = ""
}

variable "github_app_installation_id" {
  description = "Installation ID of the GitHub App on the repository owner."
  type        = string
  default     = ""
}

variable "chart_versions" {
  description = "Pinned Helm chart versions. Dependabot cannot update these; see docs/operations.md for the upgrade routine."
  type = object({
    argo_cd               = string
    argocd_apps           = string
    kube_prometheus_stack = string
    kyverno               = string
  })
  default = {
    argo_cd               = "10.11.1" # Argo CD v3.5.6
    argocd_apps           = "2.0.7"
    kube_prometheus_stack = "92.13.1"
    kyverno               = "3.9.2" # Kyverno v1.19.2
  }
}
