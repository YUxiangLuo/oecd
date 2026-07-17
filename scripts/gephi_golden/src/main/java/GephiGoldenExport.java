import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.gephi.graph.api.DirectedGraph;
import org.gephi.graph.api.GraphController;
import org.gephi.graph.api.GraphModel;
import org.gephi.graph.api.Node;
import org.gephi.project.api.ProjectController;
import org.gephi.project.api.Workspace;
import org.gephi.statistics.plugin.Degree;
import org.gephi.statistics.plugin.EigenvectorCentrality;
import org.gephi.statistics.plugin.GraphDistance;
import org.gephi.statistics.plugin.WeightedDegree;
import org.openide.util.Lookup;

/**
 * 用真实的 Gephi Toolkit 0.10.1 生成
 * {@code tests/fixtures/gephi_0_10_1_directed_reference.csv}。
 *
 * <p>这是 {@code gvcsim/indicators/network.py} 的独立基准来源：本类只调用 Gephi 官方
 * 统计实现（{@link Degree}、{@link WeightedDegree}、{@link GraphDistance}、
 * {@link EigenvectorCentrality}），不引用任何被测代码。因此“golden 回归测试”不再是
 * 拿实现反推自身，而是对齐 Gephi 真实输出。
 *
 * <p>参考图与 {@code tests/test_indicators.py::
 * test_all_network_fields_match_gephi_0_10_1_golden_export} 中的邻接矩阵一一对应，
 * 覆盖：正自环（A→A）、非对称边、不同边权、汇点（D）与隔离点（E）。
 *
 * <p>口径（与 fixture 文件名及 network_algorithm 契约一致）：
 * directed / unweighted(距离按跳数) / unnormalized，特征向量固定 100 次幂迭代。
 * GraphDistance 的最短路本身就是无权 BFS（{@code d = d + 1}），不读边权，
 * 因此边权只影响 weighted degree，不影响距离类指标。
 */
public final class GephiGoldenExport {

    private static final String[] LABELS = {"A", "B", "C", "D", "E"};

    // 有向边 (源下标, 目标下标) 及其权重；顺序、数值与 test_indicators.py 完全一致。
    private static final int[][] EDGES = {{0, 0}, {0, 1}, {1, 2}, {2, 0}, {0, 3}, {1, 3}};
    private static final double[] WEIGHTS = {5.0, 2.0, 3.0, 4.0, 7.0, 1.0};

    // 输出列顺序与表头必须与 fixture 逐字节一致（含历史大写的 "Eccentricity"）。
    private static final String HEADER =
            "node,degree,indegree,outdegree,weighted degree,weighted indegree,weighted outdegree,"
                    + "Eccentricity,closnesscentrality,harmonicclosnesscentrality,betweenesscentrality,eigencentrality";

    private static final String[] COLUMN_IDS = {
        Degree.DEGREE, Degree.INDEGREE, Degree.OUTDEGREE,
        WeightedDegree.WDEGREE, WeightedDegree.WINDEGREE, WeightedDegree.WOUTDEGREE,
        GraphDistance.ECCENTRICITY, GraphDistance.CLOSENESS, GraphDistance.HARMONIC_CLOSENESS,
        GraphDistance.BETWEENNESS, EigenvectorCentrality.EIGENVECTOR,
    };

    private GephiGoldenExport() {
    }

    public static void main(String[] args) throws IOException {
        // 默认写回 fixture（相对 scripts/gephi_golden/ 运行时）；generate.sh 会传绝对路径。
        Path out = Path.of(args.length > 0 ? args[0] : "../../tests/fixtures/gephi_0_10_1_directed_reference.csv");

        ProjectController projects = Lookup.getDefault().lookup(ProjectController.class);
        projects.newProject();
        Workspace workspace = projects.getCurrentWorkspace();
        GraphModel graphModel = Lookup.getDefault().lookup(GraphController.class).getGraphModel(workspace);
        DirectedGraph graph = graphModel.getDirectedGraph();

        Node[] nodes = new Node[LABELS.length];
        for (int i = 0; i < LABELS.length; i++) {
            nodes[i] = graphModel.factory().newNode(LABELS[i]);
            nodes[i].setLabel(LABELS[i]);
            graph.addNode(nodes[i]);
        }
        for (int k = 0; k < EDGES.length; k++) {
            // newEdge(source, target, type=0, weight, directed=true)
            graph.addEdge(graphModel.factory().newEdge(nodes[EDGES[k][0]], nodes[EDGES[k][1]], 0, WEIGHTS[k], true));
        }

        new Degree().execute(graphModel);
        new WeightedDegree().execute(graphModel);

        GraphDistance distance = new GraphDistance();
        distance.setDirected(true);
        distance.setNormalized(false);
        distance.execute(graphModel);

        EigenvectorCentrality eigenvector = new EigenvectorCentrality();
        eigenvector.setDirected(true);
        eigenvector.setNumRuns(100);
        eigenvector.execute(graphModel);

        try (Writer writer = Files.newBufferedWriter(out, StandardCharsets.UTF_8)) {
            writer.write(HEADER);
            writer.write("\n");
            for (int i = 0; i < LABELS.length; i++) {
                writer.write(LABELS[i]);
                for (String columnId : COLUMN_IDS) {
                    double value = ((Number) nodes[i].getAttribute(columnId)).doubleValue();
                    writer.write(",");
                    // 整数值输出为整数（如度、Eccentricity），其余用 Double.toString 保留全精度。
                    writer.write(value == Math.rint(value) ? Long.toString((long) value) : Double.toString(value));
                }
                writer.write("\n");
            }
        }
        System.err.println("[gephi-golden] wrote " + out.toAbsolutePath());
    }
}
