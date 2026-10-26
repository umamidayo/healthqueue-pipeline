variable "kubeconfig_path" {
  description = "Path to the kubeconfig that contains the minikube context."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "kubeconfig context to install into. Matches the minikube profile name."
  type        = string
  default     = "healthqueue"
}

variable "git_repo_url" {
  description = "Repository Argo CD syncs from. Must be reachable from inside the cluster."
  type        = string
  default     = "https://github.com/umamidayo/healthqueue-pipeline.git"
}

variable "git_revision" {
  description = "Branch or commit to sync. scripts/local/up.ps1 passes the current branch."
  type        = string
  default     = "main"
}

variable "enable_monitoring" {
  description = "Install kube-prometheus-stack. Disable on machines with < 8 GB RAM free."
  type        = bool
  default     = true
}

variable "create_root_app" {
  description = "Hand the cluster to Argo CD (true) or leave app deployment to kubectl (false, -Mode Direct)."
  type        = bool
  default     = true
}
