output "root_application" {
  value = module.platform.root_application
}

output "grafana_admin_password" {
  value     = module.platform.grafana_admin_password
  sensitive = true
}
