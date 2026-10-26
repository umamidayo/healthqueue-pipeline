output "argocd_namespace" {
  description = "Namespace Argo CD is installed in."
  value       = helm_release.argocd.namespace
}

output "root_application" {
  description = "Path Argo CD's root Application syncs from."
  value       = var.create_root_app ? "argocd/clusters/${var.cluster_name} @ ${var.git_revision}" : "(none: manifests applied directly)"
}

output "grafana_admin_password" {
  description = "Generated Grafana admin password (empty when monitoring is disabled)."
  value       = var.enable_monitoring ? random_password.grafana_admin[0].result : ""
  sensitive   = true
}
