import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AdminLayout from "@/components/admin/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Zap, Search, RefreshCw, Eye, ExternalLink, ChevronRight, ChevronLeft, CheckCircle2, AlertTriangle, XCircle, Calendar } from "lucide-react";
import { format } from "date-fns";
import { ar } from "date-fns/locale";

interface AutoApprovalRow {
  id: string;
  payment_request_id: string;
  user_id: string;
  amount: number;
  expected_amount: number | null;
  extracted_amount: number | null;
  extracted_sender: string | null;
  extracted_recipient: string | null;
  recipient_match: boolean | null;
  fraud_status: string | null;
  receipt_hash: string | null;
  created_at: string;
  // joined
  payment_status?: string | null;
  receipt_url?: string | null;
  auto_approval_scheduled_at?: string | null;
  student_name?: string;
}

const PAGE_SIZE = 25;

const AdminAutoApprovalLog = () => {
  const { loading: authLoading, isAdmin } = useAuth("admin");
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AutoApprovalRow | null>(null);

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["auto-approval-log"],
    queryFn: async () => {
      const { data: logs, error } = await supabase
        .from("auto_approval_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      const list = logs || [];
      if (list.length === 0) return [] as AutoApprovalRow[];

      const prIds = Array.from(new Set(list.map(l => l.payment_request_id)));
      const userIds = Array.from(new Set(list.map(l => l.user_id)));

      const [prRes, studentsRes] = await Promise.all([
        supabase.from("payment_requests").select("id, status, receipt_url, auto_approval_scheduled_at").in("id", prIds),
        supabase.from("students").select("user_id, first_name, second_name, third_name, fourth_name").in("user_id", userIds),
      ]);

      const prMap = new Map((prRes.data || []).map(p => [p.id, p]));
      const studentMap = new Map(
        (studentsRes.data || []).map(s => [
          s.user_id,
          [s.first_name, s.second_name, s.third_name, s.fourth_name].filter(Boolean).join(" ").trim() || "—",
        ])
      );

      return list.map(l => {
        const pr = prMap.get(l.payment_request_id);
        return {
          ...l,
          payment_status: pr?.status ?? null,
          receipt_url: pr?.receipt_url ?? null,
          auto_approval_scheduled_at: pr?.auto_approval_scheduled_at ?? null,
          student_name: studentMap.get(l.user_id) || "—",
        } as AutoApprovalRow;
      });
    },
    enabled: !authLoading && isAdmin,
    staleTime: 30 * 1000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (q) {
        const hay = [
          r.student_name,
          r.extracted_sender,
          r.extracted_recipient,
          r.receipt_hash,
          String(r.amount),
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (dateFrom) {
        if (new Date(r.created_at) < new Date(dateFrom)) return false;
      }
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        if (new Date(r.created_at) > end) return false;
      }
      return true;
    });
  }, [rows, search, dateFrom, dateTo]);

  const stats = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const today = rows.filter(r => new Date(r.created_at) >= startOfDay);
    const week = rows.filter(r => new Date(r.created_at) >= sevenDaysAgo);
    const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);
    return {
      total: rows.length,
      today: today.length,
      week: week.length,
      totalAmount,
    };
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (authLoading || isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </AdminLayout>
    );
  }

  const matchBadge = (m: boolean | null) => {
    if (m === true) return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1"><CheckCircle2 className="w-3 h-3" /> مطابق</Badge>;
    if (m === false) return <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 gap-1"><AlertTriangle className="w-3 h-3" /> غير مطابق</Badge>;
    return <Badge variant="outline" className="gap-1">—</Badge>;
  };

  const statusBadge = (s: string | null | undefined) => {
    if (s === "approved") return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">معتمد</Badge>;
    if (s === "rejected") return <Badge className="bg-destructive/15 text-destructive border-destructive/30 gap-1"><XCircle className="w-3 h-3" /> أُلغي لاحقاً</Badge>;
    if (s === "pending") return <Badge variant="outline">معلّق</Badge>;
    return <Badge variant="outline">—</Badge>;
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">سجل الاعتمادات التلقائية</h1>
            <p className="text-sm text-muted-foreground">مراجعة كل الطلبات التي اعتمدها النظام تلقائياً</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <Card><CardContent className="pt-4">
            <p className="text-2xl font-bold text-primary">{stats.total}</p>
            <p className="text-xs text-muted-foreground">الإجمالي</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4">
            <p className="text-2xl font-bold text-emerald-600">{stats.today}</p>
            <p className="text-xs text-muted-foreground">اليوم</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4">
            <p className="text-2xl font-bold text-blue-600">{stats.week}</p>
            <p className="text-xs text-muted-foreground">آخر 7 أيام</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4">
            <p className="text-lg font-bold text-foreground">{stats.totalAmount.toLocaleString("ar")} ر.ي</p>
            <p className="text-xs text-muted-foreground">إجمالي المبالغ</p>
          </CardContent></Card>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto] items-end">
              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="بحث: اسم الطالب، المستلم، المرسل، الهاش، المبلغ"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  className="pr-9"
                />
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} className="w-auto" />
                <span className="text-muted-foreground text-xs">→</span>
                <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} className="w-auto" />
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`w-4 h-4 ml-1 ${isFetching ? "animate-spin" : ""}`} />
                تحديث
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">السجلات ({filtered.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {pageRows.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">لا توجد سجلات مطابقة</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right whitespace-nowrap">التاريخ</TableHead>
                      <TableHead className="text-right whitespace-nowrap">الطالب</TableHead>
                      <TableHead className="text-right whitespace-nowrap">المبلغ (متوقع/مستخرج)</TableHead>
                      <TableHead className="text-right whitespace-nowrap">المستلم</TableHead>
                      <TableHead className="text-right whitespace-nowrap">المرسل</TableHead>
                      <TableHead className="text-right whitespace-nowrap">تطابق المستلم</TableHead>
                      <TableHead className="text-right whitespace-nowrap">حالة الطلب</TableHead>
                      <TableHead className="text-right whitespace-nowrap">إجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map(r => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {format(new Date(r.created_at), "d MMM · HH:mm", { locale: ar })}
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate">{r.student_name}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <span className="text-muted-foreground">{(r.expected_amount ?? r.amount).toLocaleString("ar")}</span>
                          <span className="mx-1">/</span>
                          <span className="font-medium">{(r.extracted_amount ?? 0).toLocaleString("ar")}</span>
                        </TableCell>
                        <TableCell className="max-w-[140px] truncate text-xs">{r.extracted_recipient || "—"}</TableCell>
                        <TableCell className="max-w-[140px] truncate text-xs">{r.extracted_sender || "—"}</TableCell>
                        <TableCell>{matchBadge(r.recipient_match)}</TableCell>
                        <TableCell>{statusBadge(r.payment_status)}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            {r.receipt_url && (
                              <Button variant="ghost" size="sm" onClick={() => window.open(r.receipt_url!, "_blank")} title="عرض السند">
                                <Eye className="w-4 h-4" />
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => navigate(`/admin/payments?id=${r.payment_request_id}`)} title="فتح الطلب">
                              <ExternalLink className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">صفحة {page + 1} من {totalPages}</p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                    <ChevronRight className="w-4 h-4" /> السابق
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                    التالي <ChevronLeft className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Details Dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              تفاصيل الاعتماد التلقائي
            </DialogTitle>
            <DialogDescription>
              {selected && format(new Date(selected.created_at), "EEEE d MMMM yyyy · HH:mm", { locale: ar })}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <DetailRow label="الطالب" value={selected.student_name || "—"} />
              <DetailRow label="المبلغ المعتمد" value={`${selected.amount.toLocaleString("ar")} ر.ي`} />
              <DetailRow label="المبلغ المتوقع" value={selected.expected_amount != null ? `${selected.expected_amount.toLocaleString("ar")} ر.ي` : "—"} />
              <DetailRow label="المبلغ المستخرج من السند" value={selected.extracted_amount != null ? `${selected.extracted_amount.toLocaleString("ar")} ر.ي` : "—"} />
              <DetailRow label="المستلم (مستخرج)" value={selected.extracted_recipient || "—"} />
              <DetailRow label="المرسل (مستخرج)" value={selected.extracted_sender || "—"} />
              <DetailRow label="تطابق المستلم" value={matchBadge(selected.recipient_match)} />
              <DetailRow label="تصنيف السند" value={<Badge variant="outline">{selected.fraud_status || "—"}</Badge>} />
              <DetailRow label="حالة الطلب الحالية" value={statusBadge(selected.payment_status)} />
              {selected.auto_approval_scheduled_at && (
                <DetailRow label="جُدول الاعتماد في" value={format(new Date(selected.auto_approval_scheduled_at), "d MMM · HH:mm:ss", { locale: ar })} />
              )}
              {selected.receipt_hash && (
                <DetailRow label="بصمة السند (SHA-256)" value={<code className="text-[10px] break-all bg-muted px-1.5 py-0.5 rounded">{selected.receipt_hash}</code>} />
              )}
              <div className="flex gap-2 pt-2 border-t">
                {selected.receipt_url && (
                  <Button variant="outline" size="sm" onClick={() => window.open(selected.receipt_url!, "_blank")}>
                    <Eye className="w-4 h-4 ml-1" /> عرض السند
                  </Button>
                )}
                <Button size="sm" onClick={() => { navigate(`/admin/payments?id=${selected.payment_request_id}`); setSelected(null); }}>
                  <ExternalLink className="w-4 h-4 ml-1" /> فتح طلب الدفع
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
};

const DetailRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/50 last:border-0">
    <span className="text-xs text-muted-foreground shrink-0">{label}</span>
    <span className="text-sm text-foreground text-left">{value}</span>
  </div>
);

export default AdminAutoApprovalLog;
