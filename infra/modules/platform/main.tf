# Platform bootstrap: everything that must exist before Argo CD can take over.
#
# OpenTofu owns the "day 0" layer (controllers and their CRDs). Argo CD owns
# everything after that (policies, alert rules, the application itself). The
# hand-off point is the root Application created by the argocd-apps chart.
# Rationale and trade-offs: docs/adr/0004-opentofu-for-platform-bootstrap.md.

locals {
  kyverno_replicas = var.high_availability ? 3 : 1
  argocd_replicas  = var.high_availability ? 2 : 1
  github_notifier  = var.github_app_id != "" && var.github_app_installation_id != ""
}

resource "helm_release" "kyverno" {
  name             = "kyverno"
  namespace        = "kyverno"
  create_namespace = true
  repository       = "https://kyverno.github.io/kyverno/"
  chart            = "kyverno"
  version          = var.chart_versions.kyverno
  atomic           = true
  wait             = true
  timeout          = 600

  values = [templatefile("${path.module}/values/kyverno.yaml.tftpl", {
    replicas   = local.kyverno_replicas
    monitoring = var.enable_monitoring
  })]

  # The ServiceMonitors Kyverno creates need the Prometheus Operator CRDs.
  depends_on = [helm_release.kube_prometheus_stack]
}

resource "random_password" "grafana_admin" {
  count   = var.enable_monitoring ? 1 : 0
  length  = 24
  special = false
}

resource "helm_release" "kube_prometheus_stack" {
  count = var.enable_monitoring ? 1 : 0

  name             = "kube-prometheus-stack"
  namespace        = "monitoring"
  create_namespace = true
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = var.chart_versions.kube_prometheus_stack
  atomic           = true
  wait             = true
  timeout          = 900

  values = [templatefile("${path.module}/values/kube-prometheus-stack.yaml.tftpl", {
    retention     = var.prometheus_retention
    local_cluster = var.cluster_name == "local"
  })]

  set_sensitive = [{
    name  = "grafana.adminPassword"
    value = random_password.grafana_admin[0].result
  }]
}

resource "helm_release" "argocd" {
  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.chart_versions.argo_cd
  atomic           = true
  wait             = true
  timeout          = 600

  values = [templatefile("${path.module}/values/argocd.yaml.tftpl", {
    argocd_url                 = var.argocd_url
    replicas                   = local.argocd_replicas
    monitoring                 = var.enable_monitoring
    github_notifier            = local.github_notifier
    github_app_id              = var.github_app_id
    github_app_installation_id = var.github_app_installation_id
  })]

  depends_on = [helm_release.kube_prometheus_stack]
}

# The hand-off: one root Application that syncs argocd/clusters/<cluster>.
# The argocd-apps chart is used instead of a kubernetes_manifest resource
# because kubernetes_manifest needs the Application CRD to exist at *plan*
# time, which breaks a fresh `tofu apply` on an empty cluster.
resource "helm_release" "root_app" {
  count = var.create_root_app ? 1 : 0

  name       = "root-app"
  namespace  = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = var.chart_versions.argocd_apps
  atomic     = true

  values = [templatefile("${path.module}/values/root-app.yaml.tftpl", {
    cluster_name = var.cluster_name
    repo_url     = var.git_repo_url
    revision     = var.git_revision
  })]

  depends_on = [helm_release.argocd, helm_release.kyverno]
}
